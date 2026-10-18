"use client";

import { useCallback, useEffect, useState } from "react";
import Sidebar from "@/components/Sidebar";
import Workspace from "@/components/Workspace";
import SegmentPanel from "@/components/SegmentPanel";
import { listPages, type PageSummary } from "@/lib/api";
import { ScanLine, Upload } from "lucide-react";

export default function Home() {
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // bump after resegment: reloads page data + busts image caches
  const [version, setVersion] = useState(0);

  const refreshPages = useCallback(async () => {
    try {
      setPages(await listPages());
    } catch (e) {
      console.error("listPages failed", e);
    }
  }, []);

  useEffect(() => {
    void refreshPages();
  }, [refreshPages]);

  return (
    <div className="flex h-screen bg-neutral-950">
      <Sidebar
        pages={pages}
        activeId={activeId}
        onSelect={setActiveId}
        onUploaded={(created) => {
          void refreshPages();
          if (created.length) setActiveId(created[0]);
        }}
      />

      <main className="flex-1 overflow-y-auto">
        {activeId ? (
          <Workspace
            key={activeId}
            pageId={activeId}
            version={version}
            onChanged={() => void refreshPages()}
            onPageDeleted={() => {
              setActiveId(null);
              void refreshPages();
            }}
          >
            <SegmentPanel
              pageId={activeId}
              version={version}
              onResegmented={() => {
                setVersion((v) => v + 1);
                void refreshPages();
              }}
            />
          </Workspace>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-neutral-500">
            <div className="rounded-full bg-neutral-900 p-6">
              <ScanLine className="h-12 w-12 text-neutral-600" />
            </div>
            <div className="text-center">
              <p className="text-base font-medium text-neutral-400">No page selected</p>
              <p className="mt-1 text-sm text-neutral-600">
                Upload a scan or pick a page from the sidebar
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}