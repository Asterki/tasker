/**
 * Global menu bar.
 *
 * Search lives on the left, utility actions on the right. The shell has no
 * logo or window chrome — the workspace itself carries the identity.
 */

import { FiPlus, FiSearch } from 'react-icons/fi';
import { ProgressHud } from './ProgressHud';

interface TopBarProps {
  onFocusSearch: () => void;
  onFocusQuickAdd: () => void;
}

export function TopBar({ onFocusSearch, onFocusQuickAdd }: TopBarProps) {
  return (
    <header className="topbar">
      <div className="topbar__left">
        <button type="button" className="search-trigger" onClick={onFocusSearch}>
          <FiSearch aria-hidden="true" />
          <span className="search-trigger__label">Search tasks</span>
          <kbd>/</kbd>
        </button>
      </div>

      <div className="topbar__right">
        <ProgressHud />
        <button type="button" className="button button--primary" onClick={onFocusQuickAdd}>
          <FiPlus aria-hidden="true" />
          Add task
        </button>
      </div>
    </header>
  );
}
