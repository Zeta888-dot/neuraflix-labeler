"use client";

import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

type Props = { children: ReactNode; label: string };
type State = { failed: boolean };

/**
 * The page preview, line thumbnails, line crop and page map draw into
 * canvases. If one of those draws fails, keep the rest of the workspace on
 * screen and offer a reload instead of blanking the page.
 */
export class OcrErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <section
          role="alert"
          className="rounded-lg bg-surface p-4 shadow-elev-2 sm:p-6"
        >
          <h2 className="text-body-md font-medium text-ink">
            {this.props.label}
          </h2>
          <p className="mt-1 text-body-sm text-body">
            Reload the page to try again. Your saved draft stays in this
            browser.
          </p>
          <Button
            type="button"
            variant="secondary"
            className="mt-4 h-11 sm:h-10"
            onClick={() => window.location.reload()}
          >
            Reload page
          </Button>
        </section>
      );
    }

    return this.props.children;
  }
}
