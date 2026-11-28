// bun test loads this before every test file (bunfig.toml), and a host a
// test starts inherits its environment.
process.env.CONNECTOME_UPDATE_CHECK = '0';
// Nor does a host a test starts ask the Models API with a test key.
process.env.MODEL_FACTS = 'off';
