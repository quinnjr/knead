<script lang="ts">
import { faCopy } from '@fortawesome/free-regular-svg-icons';
import {
  faArrowRight,
  faCheck,
  faCodeBranch,
  faFlask,
  faLayerGroup,
  faShieldHalved,
  faTerminal,
} from '@fortawesome/free-solid-svg-icons';
import Icon from '#lib/components/Icon.svelte';
import { docHref } from '#lib/links.js';
import type { PageProps } from './$types';

let { data }: PageProps = $props();

let tab = $state(0);
let copied = $state(false);
const INSTALL = 'bun add @knead-js/core @knead-js/http';

async function copyInstall() {
  try {
    await navigator.clipboard.writeText(INSTALL);
    copied = true;
    setTimeout(() => (copied = false), 1600);
  } catch {
    copied = false;
  }
}

function onTabKey(event: KeyboardEvent) {
  const count = data.tabs.length;
  if (event.key === 'ArrowRight') tab = (tab + 1) % count;
  else if (event.key === 'ArrowLeft') tab = (tab - 1 + count) % count;
  else return;
  event.preventDefault();
  document.getElementById(`hero-tab-${tab}`)?.focus();
}

// Each stage is stated as the request pipeline guide states it.
const pipeline = [
  { name: 'Host check', note: 'A Host outside allowedHosts gets 421 before anything runs.' },
  { name: 'Middleware', note: 'Global by priority, then module, controller and route.' },
  { name: 'Guards', note: 'Pass only on exactly true. Anything else is a 403.' },
  { name: 'Validation', note: 'params, query, headers and body; every issue in one 400.' },
  { name: 'Authorize', note: 'Guards that see the validated, transformed input.' },
  { name: 'Handler', note: 'Its return value becomes the response.' },
];

const limits = [
  { what: 'Request body', value: '1 MiB', outcome: '413' },
  { what: 'Query parameters', value: '1000', outcome: '400' },
  { what: 'WebSocket message', value: '256 KiB', outcome: 'closed' },
  { what: 'Sockets per IP', value: '100', outcome: '429' },
  { what: 'GraphQL depth / complexity', value: '10 / 1000', outcome: 'rejected' },
  { what: 'Errors outside development', value: 'masked', outcome: 'correlation id' },
];

const groups: { title: string; packages: { name: string; summary: string }[] }[] = [
  {
    title: 'Foundation',
    packages: [
      { name: 'core', summary: 'Modules, dependency injection, lifecycle hooks' },
      { name: 'http', summary: 'Server, controllers, pipeline, WebSockets' },
      { name: 'config', summary: 'Typed, validated configuration' },
      { name: 'logging', summary: 'NDJSON logs, redacted' },
      { name: 'testing', summary: 'Test modules on real ephemeral servers' },
    ],
  },
  {
    title: 'Hardening',
    packages: [
      { name: 'cors', summary: 'CORS with preflight handling' },
      { name: 'security-headers', summary: 'CSP with nonces, HSTS and friends' },
      { name: 'rate-limit', summary: 'Sliding window or token bucket, memory or Redis' },
      { name: 'sanitize', summary: 'Allowlist HTML sanitization' },
    ],
  },
  {
    title: 'APIs and data',
    packages: [
      { name: 'graphql', summary: 'Code-first GraphQL on Leaven' },
      { name: 'casl', summary: 'Permission catalog, token grants, guards' },
      { name: 'schedule', summary: 'Cron, interval and timeout jobs with locks' },
      { name: 'prisma', summary: 'Prisma 7 lifecycle and ambient transactions' },
    ],
  },
];
</script>

<svelte:head>
  <title>Knead · Structured servers for Bun</title>
  <meta
    name="description"
    content="Knead is a NestJS-style web framework for Bun: modules, inject()-based dependency injection and decorated controllers on standard TC39 decorators, secure by default."
  />
</svelte:head>

<section class="hero">
  <div class="hero-grid">
    <div class="hero-copy">
      <p class="eyebrow"><span class="dot" aria-hidden="true"></span>A TypeScript framework for Bun 1.4.3+</p>
      <h1>Structured servers for Bun, <em>secure from the first request.</em></h1>
      <p class="lead">
        NestJS-style modules, <code>inject()</code> dependency injection and decorated controllers on
        standard TC39 decorators. Routes compile to Bun's native router, and request limits,
        credential redaction and production error masking are already on.
      </p>
      <div class="actions">
        <a class="button primary" href={docHref('guide/getting-started')}>
          Get started <Icon icon={faArrowRight} size="0.8rem" />
        </a>
        <a class="button" href={docHref('guide/introduction')}>Read the introduction</a>
      </div>
      <div class="install">
        <Icon icon={faTerminal} size="0.75rem" />
        <code>{INSTALL}</code>
        <button type="button" onclick={copyInstall} aria-label="Copy the install command">
          <Icon icon={copied ? faCheck : faCopy} size="0.85rem" />
        </button>
        <span class="visually-hidden" aria-live="polite">{copied ? 'Copied' : ''}</span>
      </div>
    </div>

    <div class="window">
      <div class="window-bar">
        <span class="lights" aria-hidden="true"><i></i><i></i><i></i></span>
        <div class="tabs" role="tablist" aria-label="Example files">
          {#each data.tabs as file, i (file.name)}
            <button
              id="hero-tab-{i}"
              role="tab"
              type="button"
              aria-selected={tab === i}
              aria-controls="hero-panel"
              tabindex={tab === i ? 0 : -1}
              onclick={() => (tab = i)}
              onkeydown={onTabKey}
            >
              {file.name}
            </button>
          {/each}
        </div>
      </div>
      <div class="window-body prose" id="hero-panel" role="tabpanel" aria-labelledby="hero-tab-{tab}">
        {#key tab}
          <div class="code-fade">
            <!-- Rendered at build time from typechecked snippets in this repository. -->
            {@html data.tabs[tab]?.html}
          </div>
        {/key}
      </div>
      <p class="window-note">
        The <a href={docHref('guide/getting-started')}>getting started</a> app. Every example on
        this site is compiled against the packages, and its output is pinned by tests.
      </p>
    </div>
  </div>
</section>

<section class="band" aria-labelledby="pipeline-title">
  <div class="band-head">
    <p class="kicker">01 / The request pipeline</p>
    <h2 id="pipeline-title">Every request takes the same path.</h2>
    <p>
      Each layer has one job and a fixed place, so you always know what ran before your handler and
      what sees the error when something throws.
    </p>
  </div>
  <ol class="pipeline">
    {#each pipeline as stage, i (stage.name)}
      <li style:--i={i}>
        <span class="step">{String(i + 1).padStart(2, '0')}</span>
        <span class="stage">{stage.name}</span>
        <span class="note">{stage.note}</span>
      </li>
    {/each}
  </ol>
  <div class="error-lane">
    <span class="lane-label">On throw</span>
    <p>
      The error goes to the route's exception filters, then the controller's, then the global ones,
      and finally becomes an <a href="https://www.rfc-editor.org/rfc/rfc9457" rel="noreferrer">RFC 9457</a>
      problem response. It never escapes as an exception.
    </p>
    <a class="more" href={docHref('guide/middleware', 'the-request-pipeline')}>
      How the pipeline works <Icon icon={faArrowRight} size="0.7rem" />
    </a>
  </div>
</section>

<section class="band" aria-labelledby="features-title">
  <div class="band-head">
    <p class="kicker">02 / Defaults</p>
    <h2 id="features-title">The careful choices are already made.</h2>
  </div>
  <div class="bento">
    <article class="cell cell-limits">
      <div class="cell-head">
        <Icon icon={faShieldHalved} size="1rem" />
        <h3>Secure before you configure anything</h3>
      </div>
      <p>Limits that are easy to forget are on from the start. Raise one deliberately.</p>
      <dl class="limits">
        {#each limits as row, i (row.what)}
          <div style:--i={i}>
            <dt>{row.what}</dt>
            <dd><span class="value">{row.value}</span><span class="outcome">{row.outcome}</span></dd>
          </div>
        {/each}
      </dl>
      <a class="more" href={docHref('guide/security')}>
        The security model <Icon icon={faArrowRight} size="0.7rem" />
      </a>
    </article>

    <article class="cell">
      <div class="cell-head">
        <Icon icon={faCodeBranch} size="1rem" />
        <h3>Standard decorators</h3>
      </div>
      <p>
        TC39 decorators as TypeScript and Bun ship them. No <code>experimentalDecorators</code>, no
        <code>reflect-metadata</code>.
      </p>
      <pre class="mini"><code><span class="t-dec">@Controller</span>(<span class="t-str">'/todos'</span>)
<span class="t-kw">export class</span> TodosController {'{'}
  <span class="t-kw">readonly</span> #todos = <span class="t-fn">inject</span>(TodosService);
{'}'}</code></pre>
    </article>

    <article class="cell">
      <div class="cell-head">
        <Icon icon={faLayerGroup} size="1rem" />
        <h3>Typed by your schemas</h3>
      </div>
      <p>
        Any Standard Schema library validates params, query, headers and body. The handler gets the
        schema's output, already transformed.
      </p>
      <a class="more" href={docHref('guide/validation')}>Validation <Icon icon={faArrowRight} size="0.7rem" /></a>
    </article>

    <article class="cell">
      <div class="cell-head">
        <Icon icon={faFlask} size="1rem" />
        <h3>Tests run against a real server</h3>
      </div>
      <p>
        <code>Test.createModule()</code> compiles your modules with overrides, and
        <code>createApp()</code> starts the full pipeline on a random port on 127.0.0.1.
      </p>
      <a class="more" href={docHref('guide/testing')}>Testing <Icon icon={faArrowRight} size="0.7rem" /></a>
    </article>

    <article class="cell cell-log">
      <div class="cell-head">
        <Icon icon={faTerminal} size="1rem" />
        <h3>One JSON line per event, credentials removed</h3>
      </div>
      <pre class="mini log"><code>{'{'}<span class="t-key">"time"</span>:<span class="t-str">"2026-10-17T09:30:00.000Z"</span>,<span class="t-key">"level"</span>:<span class="t-str">"error"</span>,<span class="t-key">"logger"</span>:<span class="t-str">"knead"</span>,<span class="t-key">"msg"</span>:<span class="t-str">"Unhandled error on GET /reports (correlation id 0f5e9c1a-…): Error: replica postgres://<mark>***</mark>@db/shop is down"</span>{'}'}</code></pre>
      <a class="more" href={docHref('guide/logging')}>Logging <Icon icon={faArrowRight} size="0.7rem" /></a>
    </article>
  </div>
</section>

<section class="band" aria-labelledby="packages-title">
  <div class="band-head split">
    <div>
      <p class="kicker">03 / Packages</p>
      <h2 id="packages-title">Thirteen packages, one version.</h2>
    </div>
    <p>
      Every package is published under <code>@knead-js</code> and released together. Add only the
      ones you use.
    </p>
  </div>
  <div class="groups">
    {#each groups as group (group.title)}
      <div class="group">
        <h3>{group.title}</h3>
        <ul>
          {#each group.packages as pkg (pkg.name)}
            <li>
              <a href={docHref(`packages/${pkg.name}`)}>
                <code>{pkg.name}</code>
                <span>{pkg.summary}</span>
                <span class="row-arrow"><Icon icon={faArrowRight} size="0.7rem" /></span>
              </a>
            </li>
          {/each}
        </ul>
      </div>
    {/each}
  </div>
</section>

<footer class="site-footer">
  <div class="footer-inner">
    <div>
      <p class="footer-title">Start with a todo API in five files.</p>
      <a class="button primary" href={docHref('guide/getting-started')}>
        Get started <Icon icon={faArrowRight} size="0.8rem" />
      </a>
    </div>
    <div class="footer-meta">
      <p>
        Licensed under MIT or Apache-2.0. Source on
        <a href="https://github.com/quinnjr/knead" rel="noreferrer">GitHub</a>.
      </p>
      <p>
        Icons by <a href="https://fontawesome.com" rel="noreferrer">Font Awesome</a> (CC BY 4.0).
      </p>
    </div>
  </div>
</footer>

<style>
  .hero {
    position: relative;
    overflow: hidden;
    padding: 4.5rem 1.5rem 5rem;
  }

  .hero::before {
    content: '';
    position: absolute;
    inset: -1px 0 0;
    background-image:
      linear-gradient(var(--grid-line) 1px, transparent 1px),
      linear-gradient(90deg, var(--grid-line) 1px, transparent 1px);
    background-size: 28px 28px;
    mask-image: radial-gradient(ellipse 75% 65% at 60% 35%, black 25%, transparent 75%);
    -webkit-mask-image: radial-gradient(ellipse 75% 65% at 60% 35%, black 25%, transparent 75%);
    pointer-events: none;
  }

  .hero-grid {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 5fr) minmax(0, 6fr);
    gap: 4rem;
    align-items: center;
    max-width: 80rem;
    margin: 0 auto;
  }

  .hero-copy > * {
    animation: rise 0.8s var(--ease-out) both;
  }

  .hero-copy > :nth-child(2) {
    animation-delay: 60ms;
  }

  .hero-copy > :nth-child(3) {
    animation-delay: 120ms;
  }

  .hero-copy > :nth-child(4) {
    animation-delay: 180ms;
  }

  .hero-copy > :nth-child(5) {
    animation-delay: 240ms;
  }

  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(14px);
    }
  }

  .eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
    margin: 0 0 1.4rem;
    padding: 0.3rem 0.8rem 0.3rem 0.65rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--bg-raised);
    color: var(--fg-soft);
    font-family: var(--font-mono);
    font-size: 0.74rem;
  }

  .dot {
    width: 0.45rem;
    height: 0.45rem;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in oklch, var(--accent) 22%, transparent);
  }

  h1 {
    margin: 0 0 1.4rem;
    color: var(--fg);
    font-family: var(--font-display);
    font-size: clamp(2.8rem, 5.6vw, 4.6rem);
    font-weight: 400;
    line-height: 0.98;
    letter-spacing: -0.025em;
    text-wrap: balance;
  }

  h1 em {
    color: var(--accent-ink);
    font-style: italic;
  }

  .lead {
    max-width: 52ch;
    margin: 0 0 2rem;
    color: var(--fg-soft);
    font-size: 1.12rem;
    line-height: 1.65;
  }

  .lead code,
  .cell code,
  .band-head code {
    padding: 0.08em 0.35em;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-sunken);
    color: var(--fg);
    font-size: 0.86em;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-bottom: 1.6rem;
  }

  .button {
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
    min-height: 2.9rem;
    padding: 0 1.25rem;
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    background: var(--bg-raised);
    color: var(--fg);
    font-size: 0.95rem;
    font-weight: 560;
    text-decoration: none;
    transition:
      transform 0.3s var(--ease-out),
      box-shadow 0.3s var(--ease-out);
  }

  .button:hover {
    transform: translateY(-2px);
    box-shadow: var(--shadow-lift);
  }

  .button:active {
    transform: translateY(0) scale(0.98);
  }

  .button.primary {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--accent-contrast);
  }

  .button.primary :global(svg) {
    transition: transform 0.3s var(--ease-out);
  }

  .button.primary:hover :global(svg) {
    transform: translateX(3px);
  }

  .install {
    display: inline-flex;
    align-items: center;
    gap: 0.65rem;
    max-width: 100%;
    padding: 0.35rem 0.35rem 0.35rem 0.85rem;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius);
    color: var(--fg-muted);
  }

  .install code {
    overflow: hidden;
    color: var(--fg-soft);
    font-size: 0.82rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .install button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 2.5rem;
    height: 2.5rem;
    border: 0;
    border-radius: var(--radius-s);
    background: none;
    color: var(--fg-muted);
    cursor: pointer;
    transition:
      background-color 0.2s var(--ease-out),
      color 0.2s var(--ease-out);
  }

  .install button:hover {
    background: var(--bg-sunken);
    color: var(--fg);
  }

  .window {
    position: relative;
    min-width: 0;
    animation: rise 0.9s var(--ease-out) 0.15s both;
  }

  .window::before {
    content: '';
    position: absolute;
    inset: 2.5rem -1.5rem 2rem 2.5rem;
    z-index: -1;
    border-radius: 28px;
    background: color-mix(in oklch, var(--accent) 16%, var(--bg-sunken));
    transform: rotate(2.2deg);
  }

  .window-bar {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0 0.85rem;
    border: 1px solid var(--border);
    border-bottom: 0;
    border-radius: var(--radius-l) var(--radius-l) 0 0;
    background: var(--bg-sunken);
  }

  .lights {
    display: inline-flex;
    flex: none;
    gap: 0.4rem;
  }

  .lights i {
    width: 0.65rem;
    height: 0.65rem;
    border-radius: 50%;
    background: var(--border-strong);
  }

  .tabs {
    display: flex;
    gap: 0.15rem;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .tabs button {
    position: relative;
    min-height: 2.75rem;
    padding: 0 0.8rem;
    border: 0;
    background: none;
    color: var(--fg-muted);
    font-family: var(--font-mono);
    font-size: 0.76rem;
    white-space: nowrap;
    cursor: pointer;
    transition: color 0.2s var(--ease-out);
  }

  .tabs button:hover,
  .tabs button[aria-selected='true'] {
    color: var(--fg);
  }

  .tabs button[aria-selected='true']::after {
    content: '';
    position: absolute;
    left: 0.8rem;
    right: 0.8rem;
    bottom: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--accent);
    animation: grow 0.35s var(--ease-out);
  }

  @keyframes grow {
    from {
      transform: scaleX(0.3);
      opacity: 0;
    }
  }

  .window-body {
    height: 27rem;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 0 0 var(--radius-l) var(--radius-l);
    background: var(--bg-code);
    box-shadow: var(--shadow-pop);
  }

  .window-body :global(.code-block) {
    margin: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
  }

  .window-body :global(.code-head) {
    display: none;
  }

  .window-body :global(pre) {
    padding: 1.1rem 1.25rem 1.5rem;
    font-size: 0.8rem;
  }

  .code-fade {
    animation: fade-up 0.35s var(--ease-out);
  }

  @keyframes fade-up {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }

  .window-note {
    margin: 1rem 0 0;
    padding-left: 0.25rem;
    color: var(--fg-muted);
    font-size: 0.84rem;
  }

  .band {
    max-width: 80rem;
    margin: 0 auto;
    padding: 5rem 1.5rem;
    border-top: 1px solid var(--border);
  }

  .band-head {
    max-width: 44rem;
    margin-bottom: 2.75rem;
  }

  .band-head.split {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 3rem;
    align-items: end;
    max-width: none;
  }

  .band-head.split > p {
    max-width: 44ch;
  }

  .kicker {
    margin: 0 0 0.8rem;
    color: var(--accent-ink);
    font-family: var(--font-mono);
    font-size: 0.74rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .band h2 {
    margin: 0 0 0.9rem;
    color: var(--fg);
    font-family: var(--font-display);
    font-size: clamp(2.1rem, 3.8vw, 3.1rem);
    font-weight: 400;
    line-height: 1.04;
    letter-spacing: -0.02em;
  }

  .band-head p:not(.kicker) {
    margin: 0;
    color: var(--fg-soft);
    font-size: 1.05rem;
  }

  .pipeline {
    position: relative;
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    margin: 0;
    padding: 0;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-l);
    background: var(--bg-raised);
    list-style: none;
  }

  .pipeline::after {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    width: 6rem;
    height: 2px;
    background: linear-gradient(90deg, transparent, var(--accent), transparent);
    animation: travel 6s linear infinite;
    pointer-events: none;
  }

  @keyframes travel {
    from {
      transform: translateX(-6rem);
    }
    to {
      transform: translateX(80rem);
    }
  }

  .pipeline li {
    position: relative;
    display: grid;
    align-content: start;
    gap: 0.45rem;
    padding: 1.35rem 1.2rem 1.6rem;
    border-right: 1px solid var(--border);
    animation: rise 0.7s var(--ease-out) both;
    animation-delay: calc(var(--i) * 70ms);
  }

  .pipeline li:last-child {
    border-right: 0;
    background: color-mix(in oklch, var(--accent) 7%, var(--bg-raised));
  }

  .step {
    color: var(--fg-muted);
    font-family: var(--font-mono);
    font-size: 0.72rem;
  }

  .stage {
    margin-top: 0.6rem;
    color: var(--fg);
    font-size: 1.02rem;
    font-weight: 620;
    letter-spacing: -0.01em;
  }

  .note {
    color: var(--fg-muted);
    font-size: 0.86rem;
    line-height: 1.5;
  }

  .error-lane {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 1.25rem;
    align-items: center;
    margin-top: 1rem;
    padding: 1rem 1.3rem;
    border: 1px dashed color-mix(in oklch, var(--caution) 35%, var(--border));
    border-radius: var(--radius-l);
  }

  .lane-label {
    padding: 0.2rem 0.6rem;
    border-radius: 999px;
    background: color-mix(in oklch, var(--caution) 12%, var(--bg));
    color: var(--caution);
    font-family: var(--font-mono);
    font-size: 0.72rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .error-lane p {
    margin: 0;
    color: var(--fg-soft);
    font-size: 0.93rem;
  }

  .more {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--accent-ink);
    font-size: 0.88rem;
    font-weight: 560;
    text-decoration: none;
    white-space: nowrap;
  }

  .more :global(svg) {
    transition: transform 0.3s var(--ease-out);
  }

  .more:hover :global(svg) {
    transform: translateX(3px);
  }

  .bento {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    grid-auto-rows: minmax(13rem, auto);
    gap: 1rem;
  }

  .cell {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    grid-column: span 2;
    padding: 1.6rem 1.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-l);
    background: var(--bg-raised);
    transition:
      transform 0.4s var(--ease-out),
      box-shadow 0.4s var(--ease-out),
      border-color 0.3s var(--ease-out);
  }

  .cell:hover {
    border-color: var(--border-strong);
    box-shadow: var(--shadow-lift);
    transform: translateY(-3px);
  }

  .cell-limits {
    grid-column: span 4;
    grid-row: span 2;
    background:
      radial-gradient(
        120% 80% at 100% 0%,
        color-mix(in oklch, var(--accent) 9%, transparent),
        transparent 60%
      ),
      var(--bg-raised);
  }

  .cell-log {
    grid-column: span 4;
  }

  .cell-head {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    color: var(--accent-ink);
  }

  .cell h3 {
    margin: 0;
    color: var(--fg);
    font-size: 1.08rem;
    font-weight: 620;
    letter-spacing: -0.012em;
  }

  .cell p {
    margin: 0;
    color: var(--fg-soft);
    font-size: 0.94rem;
    line-height: 1.6;
  }

  .cell .more {
    margin-top: auto;
  }

  .limits {
    margin: 0.5rem 0 0.75rem;
  }

  .limits div {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 1rem;
    align-items: baseline;
    padding: 0.7rem 0;
    border-bottom: 1px solid var(--border);
  }

  .limits div:last-child {
    border-bottom: 0;
  }

  .limits dt {
    color: var(--fg-soft);
    font-size: 0.93rem;
  }

  .limits dd {
    display: inline-flex;
    gap: 0.75rem;
    align-items: baseline;
    margin: 0;
  }

  .value {
    color: var(--fg);
    font-family: var(--font-mono);
    font-size: 0.95rem;
    font-variant-numeric: tabular-nums;
  }

  .outcome {
    min-width: 7.5rem;
    color: var(--fg-muted);
    font-family: var(--font-mono);
    font-size: 0.74rem;
    text-align: right;
  }

  .mini {
    margin: auto 0 0;
    padding: 0.9rem 1rem;
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-code);
    color: var(--fg-soft);
    font-size: 0.78rem;
    line-height: 1.65;
  }

  .mini.log {
    white-space: pre-wrap;
    word-break: break-all;
  }

  .mini mark {
    padding: 0 0.15em;
    border-radius: 3px;
    background: color-mix(in oklch, var(--tip) 22%, transparent);
    color: var(--fg);
  }

  .t-dec,
  .t-key {
    color: var(--accent-ink);
  }

  .t-str {
    color: var(--tip);
  }

  .t-kw {
    color: var(--note);
  }

  .t-fn {
    color: var(--fg);
    font-weight: 600;
  }

  .groups {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 2.5rem;
  }

  .group h3 {
    margin: 0 0 0.6rem;
    color: var(--fg-muted);
    font-family: var(--font-mono);
    font-size: 0.74rem;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .group ul {
    margin: 0;
    padding: 0;
    border-top: 1px solid var(--border);
    list-style: none;
  }

  .group li {
    border-bottom: 1px solid var(--border);
  }

  .group a {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      'name arrow'
      'text arrow';
    column-gap: 1rem;
    padding: 0.85rem 0.25rem;
    color: var(--fg);
    text-decoration: none;
    transition:
      background-color 0.2s var(--ease-out),
      transform 0.3s var(--ease-out);
  }

  .group a:hover {
    background: var(--bg-sunken);
    transform: translateX(4px);
  }

  .group code {
    grid-area: name;
    color: var(--fg);
    font-size: 0.9rem;
    font-weight: 560;
  }

  .group a > span:not(.row-arrow) {
    grid-area: text;
    color: var(--fg-muted);
    font-size: 0.86rem;
  }

  .row-arrow {
    grid-area: arrow;
    align-self: center;
    color: var(--accent-ink);
    opacity: 0;
    transform: translateX(-6px);
    transition:
      opacity 0.25s var(--ease-out),
      transform 0.3s var(--ease-out);
  }

  .group a:hover .row-arrow,
  .group a:focus-visible .row-arrow {
    opacity: 1;
    transform: none;
  }

  .site-footer {
    border-top: 1px solid var(--border);
    background: var(--bg-sunken);
  }

  .footer-inner {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 2rem;
    align-items: end;
    max-width: 80rem;
    margin: 0 auto;
    padding: 4rem 1.5rem;
  }

  .footer-title {
    margin: 0 0 1.25rem;
    color: var(--fg);
    font-family: var(--font-display);
    font-size: clamp(1.9rem, 3vw, 2.5rem);
    line-height: 1.05;
    letter-spacing: -0.015em;
  }

  .footer-meta {
    color: var(--fg-muted);
    font-size: 0.84rem;
    text-align: right;
  }

  .footer-meta p {
    margin: 0.2rem 0;
  }

  @media (max-width: 1100px) {
    .hero-grid {
      grid-template-columns: minmax(0, 1fr);
      gap: 3.5rem;
    }

    .pipeline {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .pipeline li:nth-child(3) {
      border-right: 0;
    }

    .pipeline li:nth-child(-n + 3) {
      border-bottom: 1px solid var(--border);
    }

    .bento {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .cell {
      grid-column: span 1;
    }

    .cell-limits,
    .cell-log {
      grid-column: span 2;
      grid-row: auto;
    }

    .groups {
      grid-template-columns: minmax(0, 1fr);
      gap: 2rem;
    }
  }

  @media (max-width: 720px) {
    .hero {
      padding: 3rem 1rem 3.5rem;
    }

    .band {
      padding: 3.5rem 1rem;
    }

    .window::before {
      inset: 2rem -0.5rem 2rem 1.5rem;
    }

    .window-body {
      height: 22rem;
    }

    .pipeline {
      grid-template-columns: minmax(0, 1fr);
    }

    .pipeline::after {
      display: none;
    }

    .pipeline li {
      grid-template-columns: 2.5rem minmax(0, 1fr);
      gap: 0.15rem 0.5rem;
      padding: 1rem 1.1rem;
      border-right: 0;
      border-bottom: 1px solid var(--border);
    }

    .pipeline li:last-child {
      border-bottom: 0;
    }

    .step {
      grid-row: span 2;
      padding-top: 0.15rem;
    }

    .stage {
      margin: 0;
    }

    .error-lane {
      grid-template-columns: minmax(0, 1fr);
      gap: 0.75rem;
    }

    .bento {
      grid-template-columns: minmax(0, 1fr);
    }

    .cell,
    .cell-limits,
    .cell-log {
      grid-column: span 1;
    }

    .outcome {
      min-width: 0;
    }

    .band-head.split {
      grid-template-columns: minmax(0, 1fr);
      gap: 1rem;
    }

    .footer-inner {
      grid-template-columns: minmax(0, 1fr);
    }

    .footer-meta {
      text-align: left;
    }
  }
</style>
