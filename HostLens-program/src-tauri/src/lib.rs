use std::time::{Duration, Instant};

use serde::Serialize;

/// HTTP client for agent requests, reused between polls.
struct Http(reqwest::Client);

/// HTTP client for service checks: it follows redirects and has its own
/// per-check timeout, so a slow site can't hold up agent polling.
struct CheckHttp(reqwest::Client);

/// Agent endpoints the frontend may call. Query strings are allowed on GETs;
/// `{id}` matches one path segment.
const ALLOWED_ROUTES: &[(&str, &str)] = &[
    ("GET", "/health"),
    ("GET", "/api/v1/info"),
    ("GET", "/api/v1/metrics"),
    ("GET", "/api/v1/metrics/processes"),
    ("GET", "/api/v1/metrics/connections"),
    ("GET", "/api/v1/devices"),
    ("POST", "/api/v1/pair"),
    ("POST", "/api/v1/pairing-codes"),
    ("DELETE", "/api/v1/devices/{id}"),
];

fn route_allowed(method: &str, path: &str) -> bool {
    let route = path.split('?').next().unwrap_or_default();
    if method != "GET" && route != path {
        return false;
    }
    ALLOWED_ROUTES.iter().any(|(m, pattern)| {
        if *m != method {
            return false;
        }
        match pattern.strip_suffix("{id}") {
            Some(prefix) => route
                .strip_prefix(prefix)
                .is_some_and(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')),
            None => route == *pattern,
        }
    })
}

/// Call one of the agent's endpoints, authenticating with this device's token.
/// Requests go through Rust so the agent doesn't need to send CORS headers
/// (and so they carry no browser Origin, which the agent rejects by default).
/// Errors start with the HTTP status ("401 …") so the UI can react to them.
#[tauri::command]
async fn agent_request(
    http: tauri::State<'_, Http>,
    url: String,
    method: String,
    path: String,
    token: Option<String>,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    if !route_allowed(&method, &path) {
        return Err(format!("unsupported agent request: {method} {path}"));
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("agent URL must start with http:// or https://".into());
    }
    let endpoint = format!("{}{}", url.trim_end_matches('/'), path);
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut req = http.0.request(method, &endpoint);
    if let Some(token) = token.filter(|t| !t.is_empty()) {
        req = req.bearer_auth(token);
    }
    if let Some(body) = body {
        req = req.json(&body);
    }
    let res = req.send().await.map_err(|e| describe(&e))?;
    let status = res.status();
    if status == reqwest::StatusCode::NO_CONTENT {
        return Ok(serde_json::Value::Null);
    }
    if !status.is_success() {
        // The agent explains errors as { "error": "…" }.
        let message = res
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|b| b["error"].as_str().map(str::to_string))
            .unwrap_or_else(|| status.canonical_reason().unwrap_or("error").to_string());
        return Err(format!("{} {message}", status.as_u16()));
    }
    res.json().await.map_err(|e| e.to_string())
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct CheckResult {
    ok: bool,
    latency_ms: Option<u64>,
    /// "HTTP 200", "connected", or the error.
    detail: String,
}

fn elapsed_ms(start: Instant) -> Option<u64> {
    Some(start.elapsed().as_millis() as u64)
}

/// Run one service check. `kind` is "http" (target is a URL; up if the final
/// response is below 400) or "tcp" (target is host:port; up if it connects).
#[tauri::command]
async fn run_service_check(
    http: tauri::State<'_, CheckHttp>,
    kind: String,
    target: String,
    timeout_ms: u64,
) -> Result<CheckResult, String> {
    let timeout = Duration::from_millis(timeout_ms.clamp(500, 60_000));
    let start = Instant::now();
    match kind.as_str() {
        "http" => {
            let result = http.0.get(&target).timeout(timeout).send().await;
            Ok(match result {
                Ok(res) => CheckResult {
                    ok: res.status().as_u16() < 400,
                    latency_ms: elapsed_ms(start),
                    detail: format!("HTTP {}", res.status().as_u16()),
                },
                Err(e) if e.is_timeout() => CheckResult {
                    ok: false,
                    latency_ms: None,
                    detail: "timed out".into(),
                },
                Err(e) => CheckResult {
                    ok: false,
                    latency_ms: None,
                    detail: e.to_string(),
                },
            })
        }
        "tcp" => {
            // Accepts "host:port" and "[ipv6]:port"; resolves DNS names.
            let connect = tokio::net::TcpStream::connect(target.as_str());
            Ok(match tokio::time::timeout(timeout, connect).await {
                Ok(Ok(_stream)) => CheckResult {
                    ok: true,
                    latency_ms: elapsed_ms(start),
                    detail: "connected".into(),
                },
                Ok(Err(e)) => CheckResult {
                    ok: false,
                    latency_ms: None,
                    detail: e.to_string(),
                },
                Err(_) => CheckResult {
                    ok: false,
                    latency_ms: None,
                    detail: "timed out".into(),
                },
            })
        }
        other => Err(format!("unknown check kind: {other}")),
    }
}

fn describe(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "timed out".into()
    } else if e.is_connect() {
        "connection refused or unreachable".into()
    } else if let Some(status) = e.status() {
        format!("HTTP {}", status.as_u16())
    } else {
        e.to_string()
    }
}

async fn get_json(
    client: &reqwest::Client,
    url: String,
    timeout: Duration,
) -> Result<serde_json::Value, reqwest::Error> {
    client
        .get(url)
        .timeout(timeout)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct FiveMResponse {
    latency_ms: u64,
    dynamic: serde_json::Value,
    /// Only fetched when asked for: it carries the ~50 KB server icon.
    info: Option<serde_json::Value>,
    /// `None` when the server hides its player list.
    players: Option<serde_json::Value>,
}

/// Query a FiveM (FXServer) server's public HTTP endpoints. The server is
/// up when `dynamic.json` answers; `info.json` and `players.json` are extras.
#[tauri::command]
async fn fetch_fivem(
    http: tauri::State<'_, CheckHttp>,
    base_url: String,
    include_info: bool,
    timeout_ms: u64,
) -> Result<FiveMResponse, String> {
    let timeout = Duration::from_millis(timeout_ms.clamp(500, 60_000));
    query_fivem(&http.0, &base_url, include_info, timeout).await
}

async fn query_fivem(
    client: &reqwest::Client,
    base_url: &str,
    include_info: bool,
    timeout: Duration,
) -> Result<FiveMResponse, String> {
    if !(base_url.starts_with("http://") || base_url.starts_with("https://")) {
        return Err("server address must be an http(s) URL".into());
    }
    let base = base_url.trim_end_matches('/');

    let start = Instant::now();
    let dynamic = get_json(client, format!("{base}/dynamic.json"), timeout)
        .await
        .map_err(|e| describe(&e))?;
    let latency_ms = start.elapsed().as_millis() as u64;

    let info = async {
        if include_info {
            get_json(client, format!("{base}/info.json"), timeout).await.ok()
        } else {
            None
        }
    };
    let players = async { get_json(client, format!("{base}/players.json"), timeout).await.ok() };
    let (info, players) = tokio::join!(info, players);

    Ok(FiveMResponse {
        latency_ms,
        dynamic,
        info,
        players,
    })
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct CfxJoinInfo {
    /// Where the server can be queried, e.g. "http://1.2.3.4:30120".
    base_url: String,
    hostname: String,
    project_name: Option<String>,
}

/// Resolve a cfx.re join code (the "abc123" in cfx.re/join/abc123) to the
/// server's real address using the Cfx.re server list API.
#[tauri::command]
async fn resolve_cfx_join(
    http: tauri::State<'_, CheckHttp>,
    code: String,
) -> Result<CfxJoinInfo, String> {
    lookup_cfx_join(&http.0, &code).await
}

async fn lookup_cfx_join(client: &reqwest::Client, code: &str) -> Result<CfxJoinInfo, String> {
    if code.is_empty() || !code.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("invalid join code".into());
    }
    let url = format!("https://frontend.cfx-services.net/api/servers/single/{code}");
    let body = get_json(client, url, Duration::from_secs(10))
        .await
        .map_err(|e| match e.status() {
            Some(reqwest::StatusCode::NOT_FOUND) => {
                "join code not found (the server may be offline)".to_string()
            }
            _ => describe(&e),
        })?;
    let data = &body["Data"];
    let endpoint = data["connectEndPoints"]
        .as_array()
        .and_then(|list| list.iter().filter_map(|v| v.as_str()).next())
        .ok_or("the server list has no address for this server")?;
    // Proxied servers list a full URL; plain ones list "ip:port".
    let base_url = if endpoint.starts_with("http://") || endpoint.starts_with("https://") {
        endpoint.trim_end_matches('/').to_string()
    } else {
        format!("http://{endpoint}")
    };
    Ok(CfxJoinInfo {
        base_url,
        hostname: data["hostname"].as_str().unwrap_or_default().to_string(),
        project_name: data["vars"]["sv_projectName"].as_str().map(str::to_string),
    })
}

/// Post a message to a Discord webhook. Only Discord webhook URLs are accepted,
/// so this can't be used to send arbitrary requests.
#[tauri::command]
async fn send_discord_webhook(
    http: tauri::State<'_, Http>,
    webhook_url: String,
    content: String,
) -> Result<(), String> {
    let allowed = [
        "https://discord.com/api/webhooks/",
        "https://discordapp.com/api/webhooks/",
        "https://ptb.discord.com/api/webhooks/",
        "https://canary.discord.com/api/webhooks/",
    ];
    if !allowed.iter().any(|prefix| webhook_url.starts_with(prefix)) {
        return Err("not a Discord webhook URL".into());
    }
    // Discord rejects messages over 2000 characters.
    let content: String = content.chars().take(2000).collect();
    let res = http
        .0
        .post(&webhook_url)
        .json(&serde_json::json!({ "username": "HostLens", "content": content }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if res.status().is_success() {
        Ok(())
    } else {
        Err(format!("Discord returned {}", res.status()))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .expect("failed to build HTTP client");
    let check_client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent(concat!("HostLens/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("failed to build HTTP client");

    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());
    // Scanning pairing QR codes with the camera; the plugin only exists on Android/iOS.
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());

    builder
        .manage(Http(client))
        .manage(CheckHttp(check_client))
        .invoke_handler(tauri::generate_handler![
            agent_request,
            run_service_check,
            fetch_fivem,
            resolve_cfx_join,
            send_discord_webhook
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// Network tests against a live public FiveM server. They depend on that
// server being online, so they're ignored by default:
//   cargo test -- --ignored
#[cfg(test)]
mod tests {
    use super::*;

    /// "Transport Tycoon", a long-running public server.
    const JOIN_CODE: &str = "2epova";

    #[tokio::test]
    #[ignore]
    async fn resolves_join_code_and_queries_server() {
        let client = reqwest::Client::new();
        let found = lookup_cfx_join(&client, JOIN_CODE).await.expect("lookup");
        assert!(found.base_url.starts_with("http"), "{}", found.base_url);
        assert!(!found.hostname.is_empty());

        let res = query_fivem(&client, &found.base_url, true, Duration::from_secs(10))
            .await
            .expect("query");
        assert!(res.dynamic["clients"].is_number());
        assert!(res.info.as_ref().is_some_and(|i| i["vars"].is_object()));
        println!(
            "{} -> {} players in {} ms",
            found.base_url, res.dynamic["clients"], res.latency_ms
        );
    }

    #[tokio::test]
    #[ignore]
    async fn unknown_join_code_is_reported() {
        let err = lookup_cfx_join(&reqwest::Client::new(), "zzzzzz").await.unwrap_err();
        assert!(err.contains("not found"), "{err}");
    }

    #[tokio::test]
    async fn rejects_bad_input_without_network() {
        let client = reqwest::Client::new();
        assert!(lookup_cfx_join(&client, "../x").await.is_err());
        let err = query_fivem(&client, "ftp://x", false, Duration::from_secs(1)).await.err().unwrap();
        assert!(err.contains("http(s)"));
    }

    #[test]
    fn only_known_agent_routes_are_allowed() {
        assert!(route_allowed("GET", "/api/v1/metrics/processes?sort=cpu&limit=10"));
        assert!(route_allowed("POST", "/api/v1/pair"));
        assert!(route_allowed("DELETE", "/api/v1/devices/58a0631e-3681-42c1-85ce-f4d3d91be03f"));
        assert!(!route_allowed("DELETE", "/api/v1/devices/"));
        assert!(!route_allowed("DELETE", "/api/v1/devices/../info"));
        assert!(!route_allowed("POST", "/api/v1/metrics"));
        assert!(!route_allowed("POST", "/api/v1/pair?x=1"));
        assert!(!route_allowed("GET", "/api/v1/other"));
    }

    #[tokio::test]
    async fn unreachable_server_is_down() {
        // TEST-NET-3 address: nothing answers, so the request must fail cleanly.
        let err = query_fivem(&reqwest::Client::new(), "http://203.0.113.7:30120", false, Duration::from_millis(800))
            .await
            .err()
            .unwrap();
        assert!(err.contains("timed out") || err.contains("unreachable"), "{err}");
    }
}
