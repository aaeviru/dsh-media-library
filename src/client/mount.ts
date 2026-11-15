import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import { MediaLibraryIcon } from './MediaLibraryIcon.tsx';
import { MediaLibraryPanel } from './MediaLibraryPanel.tsx';
import { NS, en, zh } from './locales.ts';
import type { MediaLibraryNamespace } from './namespace.ts';

export function mountMediaLibrary(ctx: Context, mediaLibrary: MediaLibraryNamespace): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-media-library: dictionaries');
  const t = ctx.locale.bind(NS);
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        key: 'media-library',
        locale: NS,
        inject: () => ({ t, mediaLibrary }),
      },
      MediaLibraryPanel,
    ),
  );
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: 'media-library',
        order: 50,
        locale: NS,
        label: () => t('panel'),
      },
      MediaLibraryIcon,
    ),
  );
}
