// Shared fixtures for view and decision tests.
export const WF = { id: 1, name: "Eng", states: [{ id: 10, name: "Backlog", type: "backlog" }, { id: 11, name: "Ready", type: "unstarted" }, { id: 12, name: "In Dev", type: "started" }, { id: 13, name: "In Review", type: "started" }, { id: 14, name: "Done", type: "done" }] };

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
