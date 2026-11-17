//! Binary entry point: argument parsing, then the shared bootstrap in the library.
//!
//! Usage:
//!   xue-mint-server [--port N] [--photos-dir PATH] [--data-dir PATH] [--web-dir PATH]
//!   xue-mint-server --mint-token   (prints a one-time pairing code and exits)
//!
//! Folder and port chosen in the gallery settings are stored in the database and
//! used on the next start, unless the matching command-line option is given.

use anyhow::Result;
use std::path::PathBuf;
use xue_mint_server::{config::Config, db, run_server, tokens};

#[tokio::main]
async fn main() -> Result<()> {
    let mut port: Option<u16> = None;
    let mut photos_dir: Option<String> = None;
    let mut data_dir = String::from("data");
    let mut web_dir = String::from("../web/dist");
    let mut mint_token = false;

    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--port" => {
                index += 1;
                port = Some(
                    args.get(index)
                        .ok_or_else(|| anyhow::anyhow!("--port needs a value"))?
                        .parse()?,
                );
            }
            "--photos-dir" => {
                index += 1;
                photos_dir = Some(
                    args.get(index)
                        .ok_or_else(|| anyhow::anyhow!("--photos-dir needs a value"))?
                        .to_string(),
                );
            }
            "--data-dir" => {
                index += 1;
                data_dir = args
                    .get(index)
                    .ok_or_else(|| anyhow::anyhow!("--data-dir needs a value"))?
                    .to_string();
            }
            "--web-dir" => {
                index += 1;
                web_dir = args
                    .get(index)
                    .ok_or_else(|| anyhow::anyhow!("--web-dir needs a value"))?
                    .to_string();
            }
            "--mint-token" => mint_token = true,
            other => anyhow::bail!(
                "Unknown argument: {other}. Use --port, --photos-dir, --data-dir, --web-dir or --mint-token."
            ),
        }
        index += 1;
    }

    // Open the database first: settings saved from the gallery decide the folder and port.
    let mut cfg = Config {
        port: 8427,
        photos_dir: PathBuf::from("photos"),
        data_dir: data_dir.into(),
        web_dir: Some(PathBuf::from(web_dir)),
    };
    let pool = db::open(&cfg).await?;

    if mint_token {
        let token = tokens::create_token(&pool, 10 * 60).await?;
        println!("{token}");
        return Ok(());
    }

    if let Some(stored) = db::get_setting(&pool, "photos_folder").await? {
        cfg.photos_dir = PathBuf::from(stored);
    }
    if let Some(stored) = db::get_setting(&pool, "port").await? {
        if let Ok(value) = stored.parse::<u16>() {
            cfg.port = value;
        }
    }
    if let Some(value) = photos_dir {
        cfg.photos_dir = PathBuf::from(value);
    }
    if let Some(value) = port {
        cfg.port = value;
    }

    run_server(cfg, pool).await
}
