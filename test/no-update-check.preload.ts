// bun test loads this before every test file (bunfig.toml), and a host a
// test starts inherits its environment.
process.env.CONNECTOME_UPDATE_CHECK = '0';
