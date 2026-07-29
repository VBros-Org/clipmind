"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function HomeVisibilityRefresh() {
  const router = useRouter();

  useEffect(() => {
    function refresh() {
      router.refresh();
    }

    function refreshWhenVisible() {
      if (document.visibilityState === "visible") {
        refresh();
      }
    }

    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [router]);

  return null;
}
