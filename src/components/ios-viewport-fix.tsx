"use client";

import { useEffect } from "react";

export function IOSViewportFix() {
  useEffect(() => {
    const isStandalone =
      ("standalone" in navigator && (navigator as unknown as { standalone: boolean }).standalone) ||
      window.matchMedia("(display-mode: standalone)").matches;
    if (!isStandalone) return;

    const fix = () => {
      window.scrollTo(0, 1);
      requestAnimationFrame(() => window.scrollTo(0, 0));
    };

    const t1 = setTimeout(fix, 0);
    const t2 = setTimeout(fix, 120);
    const t3 = setTimeout(fix, 300);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, []);

  return null;
}
