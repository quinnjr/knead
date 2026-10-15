// prepack: copies the root license files into the package being packed (process.cwd()).
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
for (const file of ['LICENSE-MIT', 'LICENSE-APACHE']) {
  copyFileSync(join(root, file), join(process.cwd(), file));
}
