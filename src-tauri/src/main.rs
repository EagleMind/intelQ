// Prevents additional console window on Windows in release, DO NOT REMOVE!!
// #![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `intelquery mcp <context.json>` is the MCP server a Claude Code run spawns
    // (see claude.rs). It must not start a window, so it is decided before Tauri.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("mcp") {
        let Some(context) = args.get(2) else {
            eprintln!("usage: intelquery mcp <context.json>");
            std::process::exit(2);
        };
        if let Err(e) = intelquery_lib::run_mcp(std::path::Path::new(context)) {
            eprintln!("intelquery mcp: {}", e);
            std::process::exit(1);
        }
        return;
    }
    intelquery_lib::run()
}
