import { useCallback, useEffect, useState } from 'react';
import type { MediaActionResult, SpikeStatus } from '../types.ts';
import type { MediaLibraryKey } from './locales.ts';
import type { MediaLibraryNamespace } from './namespace.ts';

type Translate = (key: MediaLibraryKey) => string;

export function MediaLibraryPanel({
  t,
  mediaLibrary,
}: {
  t: Translate;
  mediaLibrary: MediaLibraryNamespace;
}) {
  const [status, setStatus] = useState<SpikeStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingMediaId, setPendingMediaId] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<MediaActionResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await mediaLibrary.spikeStatus();
      if (res.ok) {
        setStatus(res.value);
      } else {
        setLoadError(res.error.message || t('rpcError'));
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [mediaLibrary, t]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const handleAction = useCallback(
    async (action: 'open' | 'reveal', mediaId: string) => {
      setPendingMediaId(`${action}:${mediaId}`);
      try {
        const res =
          action === 'open'
            ? await mediaLibrary.openMedia(mediaId)
            : await mediaLibrary.revealMedia(mediaId);
        if (res.ok) {
          setLastResult(res.value);
        } else {
          setLastResult({
            ok: false,
            mediaId,
            action,
            code: 'OPENER_FAILED',
            message: res.error.message || t('rpcError'),
            elapsedMs: 0,
          });
        }
      } catch (err) {
        setLastResult({
          ok: false,
          mediaId,
          action,
          code: 'OPENER_FAILED',
          message: err instanceof Error ? err.message : String(err),
          elapsedMs: 0,
        });
      } finally {
        setPendingMediaId(null);
      }
    },
    [mediaLibrary, t],
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        padding: '24px',
        height: '100%',
        overflowY: 'auto',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: '12px',
        }}
      >
        <div>
          <h2 style={{ margin: '0 0 6px 0', fontSize: '20px', fontWeight: 600 }}>
            {t('heading')}
          </h2>
          <p style={{ margin: 0, opacity: 0.78, fontSize: '13px' }}>{t('subtitle')}</p>
        </div>
        <button
          type="button"
          onClick={() => void refreshStatus()}
          disabled={loading}
          style={{
            padding: '6px 12px',
            borderRadius: '6px',
            border: '1px solid rgba(128,128,128,0.35)',
            background: 'transparent',
            color: 'inherit',
            cursor: loading ? 'wait' : 'pointer',
            fontSize: '13px',
          }}
        >
          {t('refresh')}
        </button>
      </div>

      {loadError ? (
        <div
          style={{
            padding: '12px',
            borderRadius: '8px',
            border: '1px solid rgba(239,68,68,0.5)',
            background: 'rgba(239,68,68,0.1)',
            fontSize: '13px',
          }}
        >
          {loadError}
        </div>
      ) : null}

      {status ? (
        <section
          style={{
            padding: '14px 16px',
            borderRadius: '8px',
            border: '1px solid rgba(128,128,128,0.25)',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: '10px 18px',
            fontSize: '13px',
          }}
        >
          <div>
            <strong>{t('platform')}:</strong> <code>{status.platform}</code>
          </div>
          <div>
            <strong>{t('nodeVersion')}:</strong> <code>{status.nodeVersion}</code>
          </div>
          <div>
            <strong>{t('nodeSqlite')}:</strong>{' '}
            <code>
              {status.nodeSqliteAvailable ? t('statusAvailable') : t('statusMissing')}
            </code>
          </div>
          <div>
            <strong>{t('activeUncRoot')}:</strong> <code>{status.activeUncRoot}</code>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <strong>{t('localDbPath')}:</strong> <code>{status.localDatabasePath}</code>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <strong>{t('overrideConfigPath')}:</strong>{' '}
            <code>{status.spikeOverridePath}</code>
          </div>
        </section>
      ) : null}

      {lastResult ? (
        <section
          style={{
            padding: '12px 16px',
            borderRadius: '8px',
            border: lastResult.ok
              ? '1px solid rgba(34,197,94,0.45)'
              : '1px solid rgba(239,68,68,0.45)',
            background: lastResult.ok ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
            fontSize: '13px',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
          }}
        >
          <div>
            <strong>{t('lastActionHeading')}:</strong>{' '}
            <code>
              [{lastResult.ok ? 'OK' : lastResult.code}] {lastResult.action}({lastResult.mediaId})
            </code>{' '}
            <span>({lastResult.elapsedMs} ms)</span>
          </div>
          {lastResult.resolvedUncPath ? (
            <div>
              <strong>UNC:</strong> <code>{lastResult.resolvedUncPath}</code>
            </div>
          ) : null}
          {!lastResult.ok ? <div>{lastResult.message}</div> : null}
        </section>
      ) : null}

      <section style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600 }}>
          {t('testItemsHeading')}
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {(status?.items ?? []).map((item) => {
            const isOpening = pendingMediaId === `open:${item.mediaId}`;
            const isRevealing = pendingMediaId === `reveal:${item.mediaId}`;
            return (
              <div
                key={item.mediaId}
                style={{
                  padding: '12px 14px',
                  borderRadius: '8px',
                  border: '1px solid rgba(128,128,128,0.25)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '12px',
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: '13px' }}>
                    {item.label}{' '}
                    <code style={{ opacity: 0.75, fontWeight: 400 }}>({item.mediaId})</code>
                  </div>
                  <code
                    style={{
                      fontSize: '12px',
                      opacity: 0.82,
                      wordBreak: 'break-all',
                    }}
                  >
                    {item.relativePath}
                  </code>
                </div>
                <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                  <button
                    type="button"
                    disabled={isOpening || isRevealing}
                    onClick={() => void handleAction('open', item.mediaId)}
                    style={{
                      padding: '6px 10px',
                      borderRadius: '6px',
                      border: '1px solid rgba(128,128,128,0.35)',
                      background: 'transparent',
                      color: 'inherit',
                      cursor: 'pointer',
                      fontSize: '12px',
                    }}
                  >
                    {t('openBtn')}
                  </button>
                  <button
                    type="button"
                    disabled={isOpening || isRevealing}
                    onClick={() => void handleAction('reveal', item.mediaId)}
                    style={{
                      padding: '6px 10px',
                      borderRadius: '6px',
                      border: '1px solid rgba(128,128,128,0.35)',
                      background: 'transparent',
                      color: 'inherit',
                      cursor: 'pointer',
                      fontSize: '12px',
                    }}
                  >
                    {t('revealBtn')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
