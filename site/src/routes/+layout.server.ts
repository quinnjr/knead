import { getNav } from '#lib/server/content.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async () => ({ nav: await getNav() });
