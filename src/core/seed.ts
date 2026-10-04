import type { Campaign, Contact, Field, Lead, Organization, Pool, Session, User } from "./types";

export const organization: Organization = { id: 1337, name: "Nordic Energy Sales ApS" };

export const pools: Pool[] = [
  { id: 21, name: "B2B prospects", active: true },
  { id: 22, name: "B2C households", active: true },
  { id: 23, name: "Do-not-call (blacklist)", active: true },
];

// Field IDs are global; campaigns pick which ones they use.
export const fields: Field[] = [
  { id: 1, name: "Firstname", type: "text" },
  { id: 2, name: "Lastname", type: "text" },
  { id: 3, name: "Phone", type: "text" },
  { id: 4, name: "Email", type: "text" },
  { id: 5, name: "Company", type: "text" },
  { id: 6, name: "Zip", type: "text" },
  { id: 7, name: "City", type: "text" },
  { id: 20, name: "Interest", type: "text" },
  { id: 21, name: "Meeting time", type: "datetime" },
  { id: 22, name: "Deal value", type: "float" },
  { id: 23, name: "Decision maker", type: "text" },
  { id: 24, name: "Current provider", type: "text" },
];

export const campaigns: Campaign[] = [
  {
    id: 412,
    settings: { name: "Solar B2B Q4", visible: true, record: true, active: true, projectId: 7 },
    masterFields: [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id, type: "text" as const, editable: id !== 3, active: true })),
    resultFields: [
      { id: 20, type: "select", active: true, options: ["Solar", "Heat pump", "Both", "None"] },
      { id: 21, type: "text", active: true },
      { id: 22, type: "text", active: true },
      { id: 23, type: "select", active: true, options: ["Yes", "No", "Unknown"] },
    ],
  },
  {
    id: 418,
    settings: { name: "Electricity switch B2C", visible: true, record: false, active: true, projectId: 7 },
    masterFields: [1, 2, 3, 4, 6, 7].map((id) => ({ id, type: "text" as const, editable: true, active: true })),
    resultFields: [
      { id: 24, type: "select", active: true, options: ["Ørsted", "Andel", "Norlys", "Other"] },
      { id: 22, type: "text", active: true },
    ],
  },
];

export const users: User[] = [
  {
    id: 1823,
    name: "Jonas Kristensen",
    displayName: "Jonas",
    active: true,
    admin: false,
    email: "jonas@example.dk",
    locale: "da_DK",
    timezone: "Europe/Copenhagen",
  },
  { id: 1824, name: "Sofie Lund", displayName: "Sofie", active: true, admin: false, email: "sofie@example.dk", locale: "da_DK", timezone: "Europe/Copenhagen" },
  {
    id: 1801,
    name: "Camilla Holm",
    displayName: "Camilla",
    active: true,
    admin: true,
    email: "camilla@example.dk",
    locale: "da_DK",
    timezone: "Europe/Copenhagen",
  },
];

// Workers freeze Date.now() at module load, so time-relative rows are built per
// call with an explicit reference time rather than as module constants.
const dateFactory =
  (now: Date) =>
  (daysAgo: number, hour = 9): string => {
    const t = new Date(now);
    t.setUTCDate(t.getUTCDate() - daysAgo);
    t.setUTCHours(hour, 0, 0, 0);
    return t.toISOString();
  };

const pairs = (obj: Record<number, string>) => Object.entries(obj).map(([id, value]) => ({ id: Number(id), value }));

export const buildLeads = (now = new Date()): Lead[] => {
  const d = dateFactory(now);
  return [
    {
      id: 204179331,
      contactId: 479331,
      campaignId: 412,
      contactAttempts: 2,
      lastModifiedTime: d(1, 10),
      nextContactTime: null,
      importedTime: d(9),
      lastContactedBy: 1823,
      status: "success",
      active: false,
      externalId: 50012,
      masterData: pairs({ 1: "Mette", 2: "Sørensen", 3: "+45 20 12 34 56", 4: "mette.sorensen@nordicbyg.dk", 5: "Nordic Byg A/S", 6: "8000", 7: "Aarhus" }),
      resultData: pairs({ 20: "Solar", 21: d(-3, 13), 22: "48000", 23: "Yes" }),
    },
    {
      id: 204179332,
      contactId: 479332,
      campaignId: 412,
      contactAttempts: 1,
      lastModifiedTime: d(1, 11),
      nextContactTime: null,
      importedTime: d(9),
      lastContactedBy: 1824,
      status: "notInterested",
      active: false,
      externalId: 50013,
      masterData: pairs({ 1: "Lars", 2: "Nielsen", 3: "+45 31 44 55 66", 4: "lars@fjordlogistik.dk", 5: "Fjord Logistik ApS", 6: "9000", 7: "Aalborg" }),
      resultData: pairs({ 20: "None", 23: "Yes" }),
    },
    {
      id: 204179333,
      contactId: 479333,
      campaignId: 412,
      contactAttempts: 3,
      lastModifiedTime: d(0, 8),
      nextContactTime: d(-1, 14),
      importedTime: d(9),
      lastContactedBy: 1823,
      status: "privateRedial",
      active: true,
      externalId: 50014,
      masterData: pairs({ 1: "Anna", 2: "Berg", 3: "+45 40 77 88 99", 4: "anna.berg@bergkonsult.dk", 5: "Berg Konsult", 6: "5000", 7: "Odense" }),
      resultData: pairs({ 20: "Heat pump", 23: "Unknown" }),
    },
    {
      id: 204179334,
      contactId: 479334,
      campaignId: 412,
      contactAttempts: 0,
      lastModifiedTime: d(9),
      nextContactTime: null,
      importedTime: d(9),
      lastContactedBy: null,
      status: "new",
      active: true,
      externalId: 50015,
      masterData: pairs({ 1: "Peter", 2: "Holm", 3: "+45 22 33 44 55", 5: "Holm & Co", 6: "2100", 7: "København" }),
      resultData: [],
    },
    {
      id: 204179335,
      contactId: 479335,
      campaignId: 412,
      contactAttempts: 4,
      lastModifiedTime: d(2, 15),
      nextContactTime: d(0, 16),
      importedTime: d(9),
      lastContactedBy: 1824,
      status: "automaticRedial",
      active: true,
      externalId: null,
      masterData: pairs({ 1: "Kirsten", 2: "Madsen", 3: "+45 61 22 33 44", 4: "km@madsenvvs.dk", 5: "Madsen VVS", 6: "7100", 7: "Vejle" }),
      resultData: pairs({ 20: "Both" }),
    },
    {
      id: 204180001,
      contactId: 480001,
      campaignId: 418,
      contactAttempts: 1,
      lastModifiedTime: d(0, 9),
      nextContactTime: null,
      importedTime: d(4),
      lastContactedBy: 1824,
      status: "success",
      active: false,
      externalId: null,
      masterData: pairs({ 1: "Emil", 2: "Jensen", 3: "+45 50 11 22 33", 4: "emil.jensen@example.dk", 6: "4000", 7: "Roskilde" }),
      resultData: pairs({ 24: "Ørsted", 22: "5400" }),
    },
    {
      id: 204180002,
      contactId: 480002,
      campaignId: 418,
      contactAttempts: 2,
      lastModifiedTime: d(0, 9),
      nextContactTime: null,
      importedTime: d(4),
      lastContactedBy: 1823,
      status: "invalid",
      active: false,
      externalId: null,
      masterData: pairs({ 1: "Ida", 2: "Petersen", 3: "+45 00 00 00 00", 6: "6000", 7: "Kolding" }),
      resultData: [],
    },
    {
      id: 204180003,
      contactId: 480003,
      campaignId: 418,
      contactAttempts: 0,
      lastModifiedTime: d(4),
      nextContactTime: null,
      importedTime: d(4),
      lastContactedBy: null,
      status: "new",
      active: true,
      externalId: null,
      masterData: pairs({ 1: "Mikkel", 2: "Larsen", 3: "+45 71 23 45 67", 4: "mikkel.l@example.dk", 6: "8700", 7: "Horsens" }),
      resultData: [],
    },
  ];
};

// Contacts mirror the seeded leads (a lead is a contact placed on a campaign)
// plus a few pool-only contacts and one blacklist entry for dedupe demos.
export const buildContacts = (now = new Date()): Contact[] => {
  const d = dateFactory(now);
  const fromLead = (l: Lead, poolId: number, ext: string | null): Contact => ({
    id: l.contactId!,
    poolId,
    externalId: ext,
    created: l.importedTime,
    lastModifiedTime: l.lastModifiedTime,
    data: l.masterData,
  });
  const leads = buildLeads(now);
  return [
    ...leads.filter((l) => l.campaignId === 412).map((l) => fromLead(l, 21, l.externalId ? `ext-${l.externalId}` : null)),
    ...leads.filter((l) => l.campaignId === 418).map((l) => fromLead(l, 22, null)),
    {
      id: 390001,
      poolId: 21,
      externalId: "ext-1001",
      created: d(30),
      lastModifiedTime: d(30),
      data: pairs({ 1: "Henrik", 2: "Dahl", 3: "+45 42 11 22 33", 4: "henrik@dahlbyg.dk", 5: "Dahl Byg", 6: "8200", 7: "Aarhus N" }),
    },
    {
      id: 390002,
      poolId: 21,
      externalId: "ext-1002",
      created: d(30),
      lastModifiedTime: d(30),
      data: pairs({ 1: "Louise", 2: "Friis", 3: "+45 53 66 77 88", 4: "lf@friisel.dk", 5: "Friis El", 6: "8000", 7: "Aarhus" }),
    },
    { id: 390101, poolId: 23, externalId: null, created: d(60), lastModifiedTime: d(60), data: pairs({ 1: "Ole", 2: "Blocked", 3: "+45 99 88 77 66" }) },
  ];
};

export const buildSessions = (now = new Date()): Session[] => {
  const d = dateFactory(now);
  return [
    {
      id: 129389,
      leadId: 204179331,
      userId: 1823,
      campaignId: 412,
      startTime: d(1, 10),
      endTime: d(1, 10),
      lastUpdatedTime: d(1, 10),
      status: "success",
      sessionSeconds: 612,
      cdr: { destination: "004520123456", startTime: d(1, 10), answerTime: d(1, 10), endTime: d(1, 10), durationSeconds: 540, disposition: "answered" },
    },
    {
      id: 129390,
      leadId: 204179332,
      userId: 1824,
      campaignId: 412,
      startTime: d(1, 11),
      endTime: d(1, 11),
      lastUpdatedTime: d(1, 11),
      status: "notInterested",
      sessionSeconds: 95,
      cdr: { destination: "004531445566", startTime: d(1, 11), answerTime: d(1, 11), endTime: d(1, 11), durationSeconds: 70, disposition: "answered" },
    },
    {
      id: 129391,
      leadId: 204179333,
      userId: 1823,
      campaignId: 412,
      startTime: d(0, 8),
      endTime: d(0, 8),
      lastUpdatedTime: d(0, 8),
      status: "privateRedial",
      sessionSeconds: 30,
      cdr: { destination: "004540778899", startTime: d(0, 8), answerTime: null, endTime: d(0, 8), durationSeconds: 0, disposition: "noAnswer" },
    },
    {
      id: 129392,
      leadId: 204179335,
      userId: 1824,
      campaignId: 412,
      startTime: d(2, 15),
      endTime: d(2, 15),
      lastUpdatedTime: d(2, 15),
      status: "automaticRedial",
      sessionSeconds: 22,
      cdr: { destination: "004561223344", startTime: d(2, 15), answerTime: null, endTime: d(2, 15), durationSeconds: 0, disposition: "busy" },
    },
    {
      id: 129393,
      leadId: 204180001,
      userId: 1824,
      campaignId: 418,
      startTime: d(0, 9),
      endTime: d(0, 9),
      lastUpdatedTime: d(0, 9),
      status: "success",
      sessionSeconds: 410,
      cdr: { destination: "004550112233", startTime: d(0, 9), answerTime: d(0, 9), endTime: d(0, 9), durationSeconds: 380, disposition: "answered" },
    },
  ];
};
