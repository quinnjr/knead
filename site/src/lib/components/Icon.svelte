<script lang="ts">
import type { IconDefinition } from '@fortawesome/free-solid-svg-icons';

interface Props {
  icon: IconDefinition;
  /** CSS size; the icon keeps its aspect ratio. */
  size?: string;
  class?: string;
}

let { icon, size = '1em', class: className = '' }: Props = $props();

const width = $derived(icon.icon[0]);
const height = $derived(icon.icon[1]);
const d = $derived.by(() => {
  const path = icon.icon[4];
  return Array.isArray(path) ? path.join(' ') : path;
});
</script>

<svg
  class={className}
  xmlns="http://www.w3.org/2000/svg"
  viewBox="0 0 {width} {height}"
  style:height={size}
  style:width="auto"
  fill="currentColor"
  aria-hidden="true"
  focusable="false"><path {d} /></svg>
