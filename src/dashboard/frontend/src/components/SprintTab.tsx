import { Allotment } from "allotment";
import "allotment/dist/style.css";
import { IssueList } from "./IssueList";
import { SessionPanel } from "./SessionPanel";
import { ActivityFeed } from "./ActivityFeed";
import { SidePanel } from "./SidePanel";
import "./SprintTab.css";

export function SprintTab() {
  return (
    <main className="sprint-main">
      <Allotment>
        {/* Left + Center: Issues, Sessions, Activity */}
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
              <div className="panel activity-panel">
                <ActivityFeed />
              </div>
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
