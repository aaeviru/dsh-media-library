import type { MediaSortField, MediaSortOrder } from '../../types.ts';
import type { MediaLibraryKey } from '../locales.ts';
import { cx } from './primitives.ts';
import css from './styles.module.css';

export const MEDIA_SORT_FIELDS: ReadonlyArray<{
  readonly field: MediaSortField;
  readonly labelKey: MediaLibraryKey;
}> = [
  { field: 'media_date', labelKey: 'sortFieldMediaDate' },
  { field: 'added_at', labelKey: 'sortFieldAddedAt' },
  { field: 'catalog_number', labelKey: 'sortFieldCatalogNumber' },
  { field: 'filename', labelKey: 'sortFieldFilename' },
];

export interface MediaSortControlsProps {
  readonly t: (key: MediaLibraryKey) => string;
  readonly sortBy: MediaSortField;
  readonly sortOrder: MediaSortOrder;
  readonly onSortByChange: (nextSortBy: MediaSortField) => void;
  readonly onSortOrderToggle: () => void;
  readonly disabled?: boolean | undefined;
  readonly testIdPrefix?: string | undefined;
}

/**
 * Reusable multi-column sort control bar (Issue #68 B4: zero native <select>).
 * Designed for both Media Library and Metadata Backfill (#66) lists.
 */
export function MediaSortControls({
  t,
  sortBy,
  sortOrder,
  onSortByChange,
  onSortOrderToggle,
  disabled = false,
  testIdPrefix = '',
}: MediaSortControlsProps) {
  return (
    <div className={css.sortControls} data-testid={`${testIdPrefix}media-sort-controls`}>
      <span className={css.fieldLabel}>{t('sortByLabel')}</span>
      <div role="group" aria-label={t('sortByLabel')} className={css.sortSegmented}>
        {MEDIA_SORT_FIELDS.map(({ field, labelKey }) => {
          const isActive = sortBy === field;
          return (
            <button
              key={field}
              type="button"
              disabled={disabled}
              data-testid={`${testIdPrefix}sort-field-${field}`}
              aria-pressed={isActive}
              onClick={() => {
                if (field !== sortBy) onSortByChange(field);
              }}
              className={cx(css.sortSegBtn, isActive && css.sortSegBtnActive)}
            >
              {t(labelKey)}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        disabled={disabled}
        data-testid={`${testIdPrefix}sort-order-toggle-btn`}
        data-sort-order={sortOrder}
        aria-label={t('sortOrderToggleAria')}
        aria-pressed={sortOrder === 'asc'}
        onClick={onSortOrderToggle}
        className={cx(css.btn, css.btnSm)}
      >
        {sortOrder === 'desc' ? `↓ ${t('sortOrderDesc')}` : `↑ ${t('sortOrderAsc')}`}
      </button>
    </div>
  );
}
