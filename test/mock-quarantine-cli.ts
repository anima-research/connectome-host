import { main } from '../src/cli/connectome.js';
process.exitCode = await main(process.argv[2]!, process.argv.slice(3));
