// Tiny navigate helper. Hooked into the renderer's window.thihy.on('app:navigate').

import { useCallback } from 'react';

export function useNavigate(passed: (to: string) => void): (to: string) => void {
  return useCallback(
    (to: string) => {
      passed(to);
    },
    [passed],
  );
}