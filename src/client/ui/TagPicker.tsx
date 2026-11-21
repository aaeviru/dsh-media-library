import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react';
import type { TagSummary } from '../../types.ts';
import { cx } from './primitives.ts';
import css from './styles.module.css';

export interface TagPickerProps {
  readonly query: string;
  readonly onQueryChange: (next: string) => void;
  readonly candidates: readonly TagSummary[];
  readonly selectedTagId: number | null;
  readonly onSelectTag: (tag: TagSummary) => void;
  readonly showCreateOption?: boolean | undefined;
  readonly createOptionText?: string | undefined;
  readonly onCreateTag?: (() => void) | undefined;
  readonly placeholder: string;
  readonly noMatchText: string;
  readonly disabled?: boolean | undefined;
  readonly inputTestId: string;
  readonly dropdownTestId: string;
  readonly optionTestIdPrefix: string;
  readonly createOptionTestId?: string | undefined;
  readonly ariaLabel?: string | undefined;
}

/**
 * Searchable, keyboard-accessible tag combobox (Issue #28 / #47 B2).
 * Supports ArrowUp/ArrowDown/Home/End navigation, Enter selection, Escape/outside-click dismissal,
 * IME composition guard, alias display, and optional inline "+ Create & add" row.
 */
export function TagPicker({
  query,
  onQueryChange,
  candidates,
  selectedTagId,
  onSelectTag,
  showCreateOption = false,
  createOptionText,
  onCreateTag,
  placeholder,
  noMatchText,
  disabled = false,
  inputTestId,
  dropdownTestId,
  optionTestIdPrefix,
  createOptionTestId = 'tag-picker-create-option',
  ariaLabel,
}: TagPickerProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const comboboxRef = useRef<HTMLDivElement>(null);

  const hasCreate = Boolean(showCreateOption && onCreateTag && createOptionText);
  const totalOptions = (hasCreate ? 1 : 0) + candidates.length;

  useEffect(() => {
    setActiveIndex((prev) => {
      if (totalOptions <= 0) return 0;
      return prev >= totalOptions ? 0 : prev;
    });
  }, [totalOptions, query]);

  useEffect(() => {
    if (!dropdownOpen) return;
    const handleOutsideClick = (ev: MouseEvent) => {
      if (comboboxRef.current && !comboboxRef.current.contains(ev.target as Node)) {
        setDropdownOpen(false);
      }
    };
    window.addEventListener('mousedown', handleOutsideClick);
    return () => window.removeEventListener('mousedown', handleOutsideClick);
  }, [dropdownOpen]);

  const activateOptionAt = (index: number) => {
    if (disabled || totalOptions <= 0) return;
    if (hasCreate) {
      if (index === 0) {
        setDropdownOpen(false);
        onCreateTag?.();
        return;
      }
      const tag = candidates[index - 1];
      if (tag) {
        setDropdownOpen(false);
        onSelectTag(tag);
      }
    } else {
      const tag = candidates[index];
      if (tag) {
        setDropdownOpen(false);
        onSelectTag(tag);
      }
    }
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') {
      if (dropdownOpen) {
        e.preventDefault();
        setDropdownOpen(false);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!dropdownOpen) {
        setDropdownOpen(true);
        setActiveIndex(0);
      } else if (totalOptions > 0) {
        setActiveIndex((prev) => (prev + 1) % totalOptions);
      }
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!dropdownOpen) {
        setDropdownOpen(true);
        setActiveIndex(Math.max(0, totalOptions - 1));
      } else if (totalOptions > 0) {
        setActiveIndex((prev) => (prev - 1 + totalOptions) % totalOptions);
      }
      return;
    }
    if (e.key === 'Home' && dropdownOpen && totalOptions > 0) {
      e.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (e.key === 'End' && dropdownOpen && totalOptions > 0) {
      e.preventDefault();
      setActiveIndex(totalOptions - 1);
      return;
    }
    if (e.key === 'Enter' && dropdownOpen && totalOptions > 0) {
      e.preventDefault();
      activateOptionAt(activeIndex);
    }
  };

  return (
    <div ref={comboboxRef} className={css.comboboxWrap}>
      <input
        type="text"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={dropdownOpen}
        aria-autocomplete="list"
        data-testid={inputTestId}
        disabled={disabled}
        value={query}
        onFocus={() => {
          if (!disabled) setDropdownOpen(true);
        }}
        onChange={(e) => {
          onQueryChange(e.target.value);
          setDropdownOpen(true);
          setActiveIndex(0);
        }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className={cx(css.control, css.controlFull)}
      />
      {dropdownOpen && !disabled ? (
        <div role="listbox" data-testid={dropdownTestId} className={css.dropdownMenu}>
          {hasCreate ? (
            <button
              type="button"
              role="option"
              aria-selected={activeIndex === 0}
              data-active={activeIndex === 0 ? 'true' : undefined}
              data-testid={createOptionTestId}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActiveIndex(0)}
              onClick={() => activateOptionAt(0)}
              className={cx(css.dropdownCreateItem, activeIndex === 0 && css.dropdownItemActive)}
            >
              {createOptionText}
            </button>
          ) : null}

          {candidates.length === 0 && !hasCreate ? (
            <div className={css.mutedSm}>{noMatchText}</div>
          ) : (
            candidates.map((tag, idx) => {
              const optionIndex = hasCreate ? idx + 1 : idx;
              const isSelected = tag.id === selectedTagId;
              const isActive = optionIndex === activeIndex;
              return (
                <button
                  key={tag.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected || isActive}
                  data-active={isActive ? 'true' : undefined}
                  data-testid={`${optionTestIdPrefix}${tag.id}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActiveIndex(optionIndex)}
                  onClick={() => activateOptionAt(optionIndex)}
                  className={cx(
                    css.dropdownItem,
                    isSelected && css.dropdownItemSelected,
                    isActive && css.dropdownItemActive,
                  )}
                >
                  <span>
                    {tag.name}
                    {tag.aliases.length > 0 ? (
                      <span className={css.mutedSm}> ({tag.aliases.join(', ')})</span>
                    ) : null}
                  </span>
                  <span className={cx(css.mutedSm, css.tdNowrap)}>[{tag.mediaCount}]</span>
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
