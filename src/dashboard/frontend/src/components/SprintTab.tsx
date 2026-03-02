import { Allotment } from "allotment";
import "allotment/dist/style.css";
import { IssueList } from "./IssueList";
import { SessionPanel } from "./SessionPanel";
import { LogTerminal } from "./LogTerminal";
import { SidePanel } from "./SidePanel";
import "./SprintTab.css";

export function SprintTab() {
  return (
    <main className="sprint-main">
      <Allotment>
        {/* Left + Center: Issues, Sessions, Log */}
        <Allotment.Pane minSize={400}>
          <Allotment vertical>
            <Allotment.Pane minSize={150}>
              <Allotment>
                <Allotment.Pane minSize={200} preferredSize={300}>
                  <div className="panel">
                    <h2 className="panel-title">Issues</h2>
                    <IssueList />
                  </div>
                </Allotment.Pane>

                <Allotment.Pane minSize={250}>
                  <div className="panel">
                    <h2 className="panel-title">Sessions</h2>
                    <SessionPanel />
                  </div>
                </Allotment.Pane>
              </Allotment>
            </Allotment.Pane>

            <Allotment.Pane minSize={80} preferredSize={180}>
              <LogTerminal />
            </Allotment.Pane>
          </Allotment>
        </Allotment.Pane>

        {/* Right: Chat Panel (full height) */}
        <Allotment.Pane minSize={300} preferredSize={400}>
          <div className="sprint-chat-pane">
            <SidePanel />
          </div>
        </Allotment.Pane>
      </Allotment>
    </main>
  );
}
