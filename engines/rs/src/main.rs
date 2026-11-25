//! Command line: `fausth replay <fixture dir>... [--write]` compares a replay with the expected files, or (with
//! `--write`) writes them.

use std::path::Path;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some((command, rest)) = args.split_first() else { return usage() };
    if command != "replay" {
        return usage();
    }
    let write = rest.iter().any(|a| a == "--write");
    let mut failed = 0;
    for dir in rest.iter().filter(|a| *a != "--write") {
        let dir = Path::new(dir);
        let out = match fausth::replay::replay_dir(dir) {
            Ok(out) => out,
            Err(e) => {
                eprintln!("{}: {e}", dir.display());
                failed += 1;
                continue;
            }
        };
        for (name, text) in [("expected.log.jsonl", &out.log), ("expected.requests.jsonl", &out.requests)] {
            let path = dir.join(name);
            if write {
                if let Err(e) = std::fs::write(&path, text) {
                    eprintln!("{}: {e}", path.display());
                    failed += 1;
                }
            } else if std::fs::read_to_string(&path).ok().as_ref() != Some(text) {
                eprintln!("{}: differs", path.display());
                failed += 1;
            }
        }
    }
    if failed == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

fn usage() -> ExitCode {
    eprintln!("usage: fausth replay <fixture dir>... [--write]");
    ExitCode::from(2)
}
