import { useEffect, type RefObject } from "react";

interface DismissableLayerOptions {
  active: boolean;
  onDismiss(): void;
  outsideRef?: RefObject<HTMLElement | null>;
}

export function useDismissableLayer({ active, onDismiss, outsideRef }: DismissableLayerOptions) {
  useEffect(() => {
    if (!active) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    const onPointerDown = (event: PointerEvent) => {
      const root = outsideRef?.current;
      if (root === undefined || root === null || root.contains(event.target as Node)) return;
      onDismiss();
    };

    window.addEventListener("keydown", onKeyDown);
    if (outsideRef !== undefined) document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (outsideRef !== undefined) document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [active, onDismiss, outsideRef]);
}
