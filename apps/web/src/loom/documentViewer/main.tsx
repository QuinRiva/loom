import "@fontsource-variable/inter";
import "../../index.css";
import "./documentViewer.css";

import { createRoot } from "react-dom/client";

import { initializeI18n } from "~/i18n/initializeI18n";
import { DocumentViewerApp } from "./DocumentViewerApp";

// Upstream components it renders (ChatMarkdownAssetImage) call useGT(), which throws before this.
initializeI18n(() => {});
createRoot(document.getElementById("root")!).render(<DocumentViewerApp />);
