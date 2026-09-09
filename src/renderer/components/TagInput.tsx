// Tag input — chips only, no resident text field. Tags render as chips with
// an inline × to remove; adding a tag is a (+) button that opens a prompt
// (Electron's BrowserWindow doesn't implement window.prompt). The resident
// input box the user rejected is gone — the row reads as a list of chips,
// with a single trailing affordance to grow it.

import React from 'react';
import { usePrompt } from '../hooks/usePrompt';
import { IconClose, IconPlus } from './icons';

export const TagInput: React.FC<{
  value: string[];
  onChange: (tags: string[]) => void;
}> = ({ value, onChange }) => {
  const { prompt, node: promptNode } = usePrompt();

  const add = async (): Promise<void> => {
    const raw = await prompt('标签名称', '');
    if (raw == null) return;
    const tag = raw.trim().replace(/^#/, '');
    if (!tag || value.includes(tag)) return;
    onChange([...value, tag]);
  };

  const remove = (tag: string): void => {
    onChange(value.filter((t) => t !== tag));
  };

  return (
    <div className="tag-input">
      {value.map((tag) => (
        <span key={tag} className="tag-input__chip">
          #{tag}
          <button
            type="button"
            className="tag-input__remove"
            onClick={() => remove(tag)}
            aria-label={`移除标签 ${tag}`}
          >
            <IconClose size={12} />
          </button>
        </span>
      ))}
      <button type="button" className="tag-input__add" onClick={() => void add()} aria-label="添加标签">
        <IconPlus size={14} />
      </button>
      {promptNode}
    </div>
  );
};
