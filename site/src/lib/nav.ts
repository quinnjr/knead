/** Sidebar order. Every page under content/ must appear here exactly once (a test checks it). */
export const NAV: readonly { title: string; slugs: readonly string[] }[] = [
  {
    title: 'Getting started',
    slugs: ['guide/introduction', 'guide/getting-started'],
  },
  {
    title: 'Fundamentals',
    slugs: ['guide/modules', 'guide/dependency-injection', 'guide/lifecycle'],
  },
  {
    title: 'HTTP',
    slugs: [
      'guide/controllers',
      'guide/request-context',
      'guide/validation',
      'guide/errors',
      'guide/middleware',
      'guide/guards',
      'guide/exception-filters',
      'guide/server',
      'guide/websockets',
    ],
  },
  {
    title: 'Techniques',
    slugs: [
      'guide/configuration',
      'guide/logging',
      'guide/testing',
      'guide/security',
      'guide/graphql',
      'guide/authorization',
      'guide/scheduling',
      'guide/database',
    ],
  },
  {
    title: 'Packages',
    slugs: [
      'packages/core',
      'packages/http',
      'packages/config',
      'packages/logging',
      'packages/testing',
      'packages/cors',
      'packages/security-headers',
      'packages/rate-limit',
      'packages/sanitize',
      'packages/graphql',
      'packages/casl',
      'packages/schedule',
      'packages/prisma',
    ],
  },
];

export interface NavLink {
  slug: string;
  title: string;
}

export interface NavSection {
  title: string;
  links: NavLink[];
}
