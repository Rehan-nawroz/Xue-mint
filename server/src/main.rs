//! Binary entry point: argument parsing, then the shared bootstrap in the library.
//!
//! Usage:
//!   xue-mint-server [--port N] [--photos-dir PATH] [--data-dir PATH]
//!   xue-mint-server --mint-token   (prints a one-time pairing code and exits)

use anyhow::Result;
use xue_mint_server::{config::Config, db, run_server, tokens};

#[tokio::main]
async fn main() -> Result<()> {
    let mut port: u16 = 8427;
    let mut photos_dir = String::from("photos");
    let mut data_dir = String::from("data");
    let mut mint_token = false;

    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--port" => {
                index += 1;
                port = args
                    .get(index)
                    .ok_or_else(|| anyhow::anyhow!("--port needs a value"))?
                    .parse()?;
            }
            "--photos-dir" => {
                index += 1;
                photos_dir = args
                    .get(index)
                    .ok_or_else(|| anyhow::anyhow!("--photos-dir needs a value"))?
                    .to_string();
            }
            "--data-dir" => {
                index += 1;
                data_dir = args
                    .get(index)
                    .ok_or_else(|| anyhow::anyhow!("--data-dir needs a value"))?
                    .to_string();
            }
            "--mint-token" => mint_token = true,
            other => anyhow::bail!(
                "Unknown argument: {other}. Use --port, --photos-dir, --data-dir or --mint-token."
            ),
        }
        index += 1;
    }

    let cfg = Config {
        port,
        photos_dir: photos_dir.into(),
        data_dir: data_dir.into(),
    };
    let pool = db::open(&cfg).await?;

    if mint_token {
        let token = tokens::create_token(&pool, 10 * 60).await?;
        println!("{token}");
        return Ok(());
    }

    run_server(cfg, pool).await
}
