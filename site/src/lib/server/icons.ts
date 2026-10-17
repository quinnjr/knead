// Font Awesome Free icons (CC BY 4.0) as inline SVG, for HTML rendered at build time.
import { faCopy, faLightbulb } from '@fortawesome/free-regular-svg-icons';
import {
  faBan,
  faCheck,
  faCircleExclamation,
  faCircleInfo,
  faTriangleExclamation,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons';

export const ICONS = {
  info: faCircleInfo,
  lightbulb: faLightbulb,
  important: faCircleExclamation,
  warning: faTriangleExclamation,
  caution: faBan,
  copy: faCopy,
  check: faCheck,
} as const satisfies Record<string, IconDefinition>;

/** An icon as a decorative inline SVG (`aria-hidden`), sized by CSS. */
export function icon(name: keyof typeof ICONS, className?: string): string {
  const [width, height, , , path] = ICONS[name].icon;
  const d = Array.isArray(path) ? path.join(' ') : path;
  const cls = className ? ` class="${className}"` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" fill="currentColor" aria-hidden="true" focusable="false"${cls}><path d="${d}"/></svg>`;
}
