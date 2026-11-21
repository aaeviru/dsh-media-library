export { Button, MenuSurface, Pill, Tag } from '@deepseek-ai/dsh-client-ui-primitives';
export type { ButtonVariant, MenuSurfaceProps, TagTone } from '@deepseek-ai/dsh-client-ui-primitives';

/** Join truthy CSS class names without introducing an external dependency. */
export function cx(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
