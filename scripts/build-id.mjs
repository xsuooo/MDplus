// Node >=22 supports the strip-types flag used by the Windows delivery entry point.
import { buildId } from '../config/build.ts';

if (process.argv[2]) process.chdir(process.argv[2]);
process.stdout.write(buildId());
