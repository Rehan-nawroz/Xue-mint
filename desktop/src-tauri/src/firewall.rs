//! Re-export the shared firewall control used by the setup window and the
//! gallery's phone-connection settings.

pub use xue_mint_server::firewall::{add_rule, remove_rule, rule_exists, FirewallResult};
