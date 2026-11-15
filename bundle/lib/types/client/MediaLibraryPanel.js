import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useState } from 'react';
export function MediaLibraryPanel({ t, mediaLibrary, }) {
    const [status, setStatus] = useState(null);
    const [loading, setLoading] = useState(false);
    const [pendingMediaId, setPendingMediaId] = useState(null);
    const [lastResult, setLastResult] = useState(null);
    const [loadError, setLoadError] = useState(null);
    const refreshStatus = useCallback(async () => {
        setLoading(true);
        setLoadError(null);
        try {
            const res = await mediaLibrary.spikeStatus();
            if (res.ok) {
                setStatus(res.value);
            }
            else {
                setLoadError(res.error.message || t('rpcError'));
            }
        }
        catch (err) {
            setLoadError(err instanceof Error ? err.message : String(err));
        }
        finally {
            setLoading(false);
        }
    }, [mediaLibrary, t]);
    useEffect(() => {
        void refreshStatus();
    }, [refreshStatus]);
    const handleAction = useCallback(async (action, mediaId) => {
        setPendingMediaId(`${action}:${mediaId}`);
        try {
            const res = action === 'open'
                ? await mediaLibrary.openMedia(mediaId)
                : await mediaLibrary.revealMedia(mediaId);
            if (res.ok) {
                setLastResult(res.value);
            }
            else {
                setLastResult({
                    ok: false,
                    mediaId,
                    action,
                    code: 'OPENER_FAILED',
                    message: res.error.message || t('rpcError'),
                    elapsedMs: 0,
                });
            }
        }
        catch (err) {
            setLastResult({
                ok: false,
                mediaId,
                action,
                code: 'OPENER_FAILED',
                message: err instanceof Error ? err.message : String(err),
                elapsedMs: 0,
            });
        }
        finally {
            setPendingMediaId(null);
        }
    }, [mediaLibrary, t]);
    return (_jsxs("div", { style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            padding: '24px',
            height: '100%',
            overflowY: 'auto',
            boxSizing: 'border-box',
        }, children: [_jsxs("div", { style: {
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    gap: '12px',
                }, children: [_jsxs("div", { children: [_jsx("h2", { style: { margin: '0 0 6px 0', fontSize: '20px', fontWeight: 600 }, children: t('heading') }), _jsx("p", { style: { margin: 0, opacity: 0.78, fontSize: '13px' }, children: t('subtitle') })] }), _jsx("button", { type: "button", onClick: () => void refreshStatus(), disabled: loading, style: {
                            padding: '6px 12px',
                            borderRadius: '6px',
                            border: '1px solid rgba(128,128,128,0.35)',
                            background: 'transparent',
                            color: 'inherit',
                            cursor: loading ? 'wait' : 'pointer',
                            fontSize: '13px',
                        }, children: t('refresh') })] }), loadError ? (_jsx("div", { style: {
                    padding: '12px',
                    borderRadius: '8px',
                    border: '1px solid rgba(239,68,68,0.5)',
                    background: 'rgba(239,68,68,0.1)',
                    fontSize: '13px',
                }, children: loadError })) : null, status ? (_jsxs("section", { style: {
                    padding: '14px 16px',
                    borderRadius: '8px',
                    border: '1px solid rgba(128,128,128,0.25)',
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                    gap: '10px 18px',
                    fontSize: '13px',
                }, children: [_jsxs("div", { children: [_jsxs("strong", { children: [t('platform'), ":"] }), " ", _jsx("code", { children: status.platform })] }), _jsxs("div", { children: [_jsxs("strong", { children: [t('nodeVersion'), ":"] }), " ", _jsx("code", { children: status.nodeVersion })] }), _jsxs("div", { children: [_jsxs("strong", { children: [t('nodeSqlite'), ":"] }), ' ', _jsx("code", { children: status.nodeSqliteAvailable ? t('statusAvailable') : t('statusMissing') })] }), _jsxs("div", { children: [_jsxs("strong", { children: [t('activeUncRoot'), ":"] }), " ", _jsx("code", { children: status.activeUncRoot })] }), _jsxs("div", { style: { gridColumn: '1 / -1' }, children: [_jsxs("strong", { children: [t('localDbPath'), ":"] }), " ", _jsx("code", { children: status.localDatabasePath })] }), _jsxs("div", { style: { gridColumn: '1 / -1' }, children: [_jsxs("strong", { children: [t('overrideConfigPath'), ":"] }), ' ', _jsx("code", { children: status.spikeOverridePath })] })] })) : null, lastResult ? (_jsxs("section", { style: {
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
                }, children: [_jsxs("div", { children: [_jsxs("strong", { children: [t('lastActionHeading'), ":"] }), ' ', _jsxs("code", { children: ["[", lastResult.ok ? 'OK' : lastResult.code, "] ", lastResult.action, "(", lastResult.mediaId, ")"] }), ' ', _jsxs("span", { children: ["(", lastResult.elapsedMs, " ms)"] })] }), lastResult.resolvedUncPath ? (_jsxs("div", { children: [_jsx("strong", { children: "UNC:" }), " ", _jsx("code", { children: lastResult.resolvedUncPath })] })) : null, !lastResult.ok ? _jsx("div", { children: lastResult.message }) : null] })) : null, _jsxs("section", { style: { display: 'flex', flexDirection: 'column', gap: '10px' }, children: [_jsx("h3", { style: { margin: 0, fontSize: '15px', fontWeight: 600 }, children: t('testItemsHeading') }), _jsx("div", { style: { display: 'flex', flexDirection: 'column', gap: '8px' }, children: (status?.items ?? []).map((item) => {
                            const isOpening = pendingMediaId === `open:${item.mediaId}`;
                            const isRevealing = pendingMediaId === `reveal:${item.mediaId}`;
                            return (_jsxs("div", { style: {
                                    padding: '12px 14px',
                                    borderRadius: '8px',
                                    border: '1px solid rgba(128,128,128,0.25)',
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    gap: '12px',
                                    flexWrap: 'wrap',
                                }, children: [_jsxs("div", { style: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }, children: [_jsxs("div", { style: { fontWeight: 600, fontSize: '13px' }, children: [item.label, ' ', _jsxs("code", { style: { opacity: 0.75, fontWeight: 400 }, children: ["(", item.mediaId, ")"] })] }), _jsx("code", { style: {
                                                    fontSize: '12px',
                                                    opacity: 0.82,
                                                    wordBreak: 'break-all',
                                                }, children: item.relativePath })] }), _jsxs("div", { style: { display: 'flex', gap: '8px', flexShrink: 0 }, children: [_jsx("button", { type: "button", disabled: isOpening || isRevealing, onClick: () => void handleAction('open', item.mediaId), style: {
                                                    padding: '6px 10px',
                                                    borderRadius: '6px',
                                                    border: '1px solid rgba(128,128,128,0.35)',
                                                    background: 'transparent',
                                                    color: 'inherit',
                                                    cursor: 'pointer',
                                                    fontSize: '12px',
                                                }, children: t('openBtn') }), _jsx("button", { type: "button", disabled: isOpening || isRevealing, onClick: () => void handleAction('reveal', item.mediaId), style: {
                                                    padding: '6px 10px',
                                                    borderRadius: '6px',
                                                    border: '1px solid rgba(128,128,128,0.35)',
                                                    background: 'transparent',
                                                    color: 'inherit',
                                                    cursor: 'pointer',
                                                    fontSize: '12px',
                                                }, children: t('revealBtn') })] })] }, item.mediaId));
                        }) })] })] }));
}
//# sourceMappingURL=MediaLibraryPanel.js.map