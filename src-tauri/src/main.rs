#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--setup") {
        let workspace = match args.get(2).map(String::as_str) {
            None => None,
            Some("--workspace") if args.len() == 4 => args.get(3).map(String::as_str),
            _ => {
                eprintln!("Usage: seabird-workbench --setup [--workspace <path>]");
                std::process::exit(2);
            }
        };
        match seabird_workbench_lib::run_setup(workspace) {
            Ok((report, ok)) => {
                println!("{report}");
                if !ok {
                    std::process::exit(1);
                }
            }
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    } else if args.get(1).map(String::as_str) == Some("--mcp") {
        if let Some(workspace) = args.get(2) {
            if let Err(error) = seabird_workbench_lib::run_bridge(workspace) {
                eprintln!("{error}");
                std::process::exit(1);
            }
        } else {
            eprintln!("Usage: seabird-workbench --mcp <workspace>");
            std::process::exit(2);
        }
    } else if args.get(1).is_some_and(|arg| !arg.starts_with("-psn_")) {
        std::process::exit(seabird_workbench_lib::run_cli(&args[1..]));
    } else {
        seabird_workbench_lib::run()
    }
}
