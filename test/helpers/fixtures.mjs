// Shared fixtures for view and decision tests.
export const WF = { id: 1, name: "Eng", states: [{ id: 10, name: "Backlog", type: "backlog", position: 1 }, { id: 11, name: "Ready", type: "unstarted", position: 2 }, { id: 12, name: "In Dev", type: "started", position: 3 }, { id: 13, name: "In Review", type: "started", position: 4 }, { id: 14, name: "Done", type: "done", position: 5 }] };

export const S = (id, name, stateId) => ({
  id, name, workflow_id: 1, workflow_state_id: stateId, owner_ids: ["me"],
  app_url: `https://app.shortcut.com/w/story/${id}`,
  labels: [], branches: [], pull_requests: [], custom_fields: [],
  group_id: null, epic_id: null, iteration_id: null, archived: false, description: "",
});

// A fresh route map for the fetch stub.
export const basic = () => ({
  "GET /member": { id: "me", mention_name: "jer", name: "Jer" },
  "GET /workflows": [WF],
  "GET /groups": [],
  "GET /epics": [],
  "GET /iterations": [],
  "GET /custom-fields": [],
  "GET /search/stories": { data: [], next: null },
  "POST /stories/search": { data: [S(1, "Alpha", 11), S(2, "Beta", 12)], next: null },
});
