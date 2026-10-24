// Loaded before every test file (bunfig.toml): a host a test starts inherits
// this, so it doesn't read npm's registry for an update notice. A test of the
// notice gives its host CONNECTOME_UPDATE_CHECK=1 and a registry of its own.
process.env.CONNECTOME_UPDATE_CHECK = '0';
