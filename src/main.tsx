import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  User
} from "firebase/auth";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAfter,
  updateDoc,
  where,
  QueryDocumentSnapshot,
  DocumentData
} from "firebase/firestore";

import { auth, db } from "./firebase";
import "./styles.css";
import { getFunctions, httpsCallable } from "firebase/functions";

const functions = getFunctions(undefined, "us-central1");

const rebuildQuestionPacksFunction = httpsCallable<
  { category: string },
  {
    ok: boolean;
    results: {
      category: string;
      deleted: number;
      questionCount: number;
      packCount: number;
    }[];
  }
>(functions, "rebuildQuestionPacks");

type AdminTab = "drafts" | "submissions" | "serverConfig";
type SubmissionStatusFilter = "pending" | "approved" | "rejected" | "all";

type QuestionOption = {
  id: string;
  text: string;
};

type QuestionRow = {
  id: string;
  text: string;
  category: string;
  options: QuestionOption[];
  qualityScore?: number;
  qualityReasons?: string[];
  generationBatchId?: string;
  fingerprint?: string;
};

type SubmittedQuestion = {
  id: string;
  text: string;
  category: string;
  options: QuestionOption[];
  submittedBy?: string;
  status: string;
  fingerprint?: string;
  createdAt?: unknown;
};

type EditableSubmission = {
  text: string;
  category: string;
  optionA: string;
  optionB: string;
};

type ServerConfig = {
  submissionsEnabled: boolean;
  maxSubmissionsPerDay: number;
  minSecondsBetweenSubmissions: number;
  rejectedSubmissionRetentionDays: number;
  analyticsRetentionDays: number;
};

const DEFAULT_SERVER_CONFIG: ServerConfig = {
  submissionsEnabled: true,
  maxSubmissionsPerDay: 5,
  minSecondsBetweenSubmissions: 45,
  rejectedSubmissionRetentionDays: 30,
  analyticsRetentionDays: 90
};

const ADMIN_EMAILS = String(import.meta.env.VITE_ADMIN_EMAILS || "")
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

const PAGE_SIZE = 100;

const CATEGORIES = [
  "general",
  "lifestyle",
  "work",
  "curiosity",
  "mindset",
  "money",
  "relationships",
  "entertainment",
  "habits"
];

function normalizeOptions(data: DocumentData): QuestionOption[] {
  if (Array.isArray(data.options)) {
    return data.options;
  }

  if (data.optionA || data.optionB) {
    return [
      { id: "a", text: data.optionA ?? "" },
      { id: "b", text: data.optionB ?? "" }
    ];
  }

  return [];
}

function normalizeQuestionText(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ");
}

function createQuestionFingerprint(params: {
  text: string;
  optionA: string;
  optionB: string;
}) {
  const text = normalizeQuestionText(params.text);
  const options = [
    normalizeQuestionText(params.optionA),
    normalizeQuestionText(params.optionB)
  ].sort();

  return `${text}|${options[0]}|${options[1]}`;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function App() {
  const [tab, setTab] = useState<AdminTab>("drafts");
  const [submissionStatusFilter, setSubmissionStatusFilter] =
    useState<SubmissionStatusFilter>("pending");

  const [user, setUser] = useState<User | null>(null);

  const [drafts, setDrafts] = useState<QuestionRow[]>([]);
  const [submissions, setSubmissions] = useState<SubmittedQuestion[]>([]);

  const [selectedDraftIds, setSelectedDraftIds] = useState<string[]>([]);
  const [selectedSubmissionIds, setSelectedSubmissionIds] = useState<string[]>(
    []
  );

  const [editingSubmissionId, setEditingSubmissionId] = useState<string | null>(
    null
  );
  const [editableSubmission, setEditableSubmission] =
    useState<EditableSubmission>({
      text: "",
      category: "general",
      optionA: "",
      optionB: ""
    });

  const [lastDraftDoc, setLastDraftDoc] =
    useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [lastSubmissionDoc, setLastSubmissionDoc] =
    useState<QueryDocumentSnapshot<DocumentData> | null>(null);

  const [hasMoreDrafts, setHasMoreDrafts] = useState(false);
  const [hasMoreSubmissions, setHasMoreSubmissions] = useState(false);

  const [serverConfig, setServerConfig] =
    useState<ServerConfig>(DEFAULT_SERVER_CONFIG);

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [maxScoreFilter, setMaxScoreFilter] = useState("all");

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState("");

  const firebaseProjectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;

  const isAdmin = user?.email
    ? ADMIN_EMAILS.includes(user.email.toLowerCase())
    : false;

  const visibleDrafts = useMemo(() => {
    return drafts.filter((draft) => {
      const matchesSearch =
        search.trim().length === 0 ||
        draft.text.toLowerCase().includes(search.toLowerCase()) ||
        draft.options.some((option) =>
          option.text.toLowerCase().includes(search.toLowerCase())
        );

      const matchesCategory =
        categoryFilter === "all" || draft.category === categoryFilter;

      const score = draft.qualityScore ?? 100;
      const matchesScore =
        maxScoreFilter === "all" || score <= Number(maxScoreFilter);

      return matchesSearch && matchesCategory && matchesScore;
    });
  }, [drafts, search, categoryFilter, maxScoreFilter]);

  const visibleSubmissions = useMemo(() => {
    return submissions.filter((submission) => {
      const matchesSearch =
        search.trim().length === 0 ||
        submission.text.toLowerCase().includes(search.toLowerCase()) ||
        submission.options.some((option) =>
          option.text.toLowerCase().includes(search.toLowerCase())
        );

      const matchesCategory =
        categoryFilter === "all" || submission.category === categoryFilter;

      return matchesSearch && matchesCategory;
    });
  }, [submissions, search, categoryFilter]);

  const allVisibleDraftsSelected =
    visibleDrafts.length > 0 &&
    visibleDrafts.every((draft) => selectedDraftIds.includes(draft.id));

  const allVisibleSubmissionsSelected =
    visibleSubmissions.length > 0 &&
    visibleSubmissions.every((submission) =>
      selectedSubmissionIds.includes(submission.id)
    );

  useEffect(() => {
    return onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setIsLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!isAdmin) return;

    if (tab === "drafts") {
      void loadDrafts(true);
    }

    if (tab === "submissions") {
      void loadSubmissions(true);
    }

    if (tab === "serverConfig") {
      void loadServerConfig();
    }
  }, [isAdmin, tab, submissionStatusFilter]);

  async function login() {
    const provider = new GoogleAuthProvider();
    await signInWithPopup(auth, provider);
  }

  async function loadDrafts(reset = false) {
    setIsLoading(true);
    setLoadError("");

    try {
      const constraints = [
        where("status", "==", "draft"),
        orderBy("createdAt", "desc"),
        limit(PAGE_SIZE)
      ];

      const draftQuery =
        reset || !lastDraftDoc
          ? query(collection(db, "questions"), ...constraints)
          : query(
              collection(db, "questions"),
              ...constraints,
              startAfter(lastDraftDoc)
            );

      const snapshot = await getDocs(draftQuery);

      const rows = snapshot.docs.map((docSnap) => {
        const data = docSnap.data();

        return {
          id: docSnap.id,
          text: data.text ?? "",
          category: data.category ?? "general",
          options: normalizeOptions(data),
          qualityScore: data.qualityScore,
          qualityReasons: data.qualityReasons ?? [],
          generationBatchId: data.generationBatchId,
          fingerprint: data.fingerprint
        };
      });

      setDrafts((current) => (reset ? rows : [...current, ...rows]));
      setLastDraftDoc(snapshot.docs[snapshot.docs.length - 1] ?? null);
      setHasMoreDrafts(snapshot.docs.length === PAGE_SIZE);

      if (reset) setSelectedDraftIds([]);
    } catch (error) {
      setLoadError(`Could not load AI drafts: ${getErrorMessage(error)}`);
    } finally {
      setIsLoading(false);
    }
  }

  async function loadSubmissions(reset = false) {
    setIsLoading(true);
    setLoadError("");

    try {
      const constraints =
        submissionStatusFilter === "all"
          ? [orderBy("createdAt", "desc"), limit(PAGE_SIZE)]
          : [
              where("status", "==", submissionStatusFilter),
              orderBy("createdAt", "desc"),
              limit(PAGE_SIZE)
            ];

      const submissionQuery =
        reset || !lastSubmissionDoc
          ? query(collection(db, "submittedQuestions"), ...constraints)
          : query(
              collection(db, "submittedQuestions"),
              ...constraints,
              startAfter(lastSubmissionDoc)
            );

      const snapshot = await getDocs(submissionQuery);

      const rows = snapshot.docs.map((docSnap) => {
        const data = docSnap.data();

        return {
          id: docSnap.id,
          text: data.text ?? "",
          category: data.category ?? "general",
          options: normalizeOptions(data),
          submittedBy: data.submittedBy,
          status: data.status ?? "unknown",
          fingerprint: data.fingerprint,
          createdAt: data.createdAt
        };
      });

      setSubmissions((current) => (reset ? rows : [...current, ...rows]));
      setLastSubmissionDoc(snapshot.docs[snapshot.docs.length - 1] ?? null);
      setHasMoreSubmissions(snapshot.docs.length === PAGE_SIZE);

      if (reset) setSelectedSubmissionIds([]);
    } catch (error) {
      setLoadError(
        `Could not load user submissions. Error: ${getErrorMessage(error)}`
      );

      setSubmissions([]);
      setLastSubmissionDoc(null);
      setHasMoreSubmissions(false);
    } finally {
      setIsLoading(false);
    }
  }

  async function loadServerConfig() {
    setIsLoading(true);
    setLoadError("");

    try {
      const snapshot = await getDoc(doc(db, "serverConfig", "app"));

      if (!snapshot.exists()) {
        setServerConfig(DEFAULT_SERVER_CONFIG);
        return;
      }

      const data = snapshot.data();

      setServerConfig({
        submissionsEnabled: Boolean(
          data.submissionsEnabled ?? DEFAULT_SERVER_CONFIG.submissionsEnabled
        ),
        maxSubmissionsPerDay: Number(
          data.maxSubmissionsPerDay ??
            DEFAULT_SERVER_CONFIG.maxSubmissionsPerDay
        ),
        minSecondsBetweenSubmissions: Number(
          data.minSecondsBetweenSubmissions ??
            DEFAULT_SERVER_CONFIG.minSecondsBetweenSubmissions
        ),
        rejectedSubmissionRetentionDays: Number(
          data.rejectedSubmissionRetentionDays ??
            DEFAULT_SERVER_CONFIG.rejectedSubmissionRetentionDays
        ),
        analyticsRetentionDays: Number(
          data.analyticsRetentionDays ?? DEFAULT_SERVER_CONFIG.analyticsRetentionDays
        )
      });
    } catch (error) {
      setLoadError(`Could not load server config: ${getErrorMessage(error)}`);
    } finally {
      setIsLoading(false);
    }
  }

  async function saveServerConfig() {
    setIsSaving(true);
    setLoadError("");

    try {
      await setDoc(
        doc(db, "serverConfig", "app"),
        {
          ...serverConfig,
          updatedAt: serverTimestamp(),
          updatedBy: user?.email ?? null
        },
        { merge: true }
      );

      alert("Server config saved.");
    } catch (error) {
      setLoadError(`Could not save server config: ${getErrorMessage(error)}`);
    } finally {
      setIsSaving(false);
    }
  }

  function toggleDraftSelected(id: string) {
    setSelectedDraftIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id]
    );
  }

  function toggleSubmissionSelected(id: string) {
    setSelectedSubmissionIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id]
    );
  }

  function toggleAllVisibleDrafts() {
    if (allVisibleDraftsSelected) {
      setSelectedDraftIds((current) =>
        current.filter((id) => !visibleDrafts.some((draft) => draft.id === id))
      );
      return;
    }

    setSelectedDraftIds((current) =>
      Array.from(new Set([...current, ...visibleDrafts.map((draft) => draft.id)]))
    );
  }

  function toggleAllVisibleSubmissions() {
    if (allVisibleSubmissionsSelected) {
      setSelectedSubmissionIds((current) =>
        current.filter(
          (id) => !visibleSubmissions.some((item) => item.id === id)
        )
      );
      return;
    }

    setSelectedSubmissionIds((current) =>
      Array.from(
        new Set([...current, ...visibleSubmissions.map((item) => item.id)])
      )
    );
  }

  function startEditingSubmission(submission: SubmittedQuestion) {
    setEditingSubmissionId(submission.id);
    setEditableSubmission({
      text: submission.text,
      category: submission.category,
      optionA: submission.options[0]?.text ?? "",
      optionB: submission.options[1]?.text ?? ""
    });
  }

  function cancelEditingSubmission() {
    setEditingSubmissionId(null);
    setEditableSubmission({
      text: "",
      category: "general",
      optionA: "",
      optionB: ""
    });
  }

  async function saveEditedSubmission() {
    if (!editingSubmissionId) return;

    const text = editableSubmission.text.trim().replace(/\s+/g, " ");
    const optionA = editableSubmission.optionA.trim().replace(/\s+/g, " ");
    const optionB = editableSubmission.optionB.trim().replace(/\s+/g, " ");
    const category = editableSubmission.category.trim().toLowerCase();

    if (!text || !optionA || !optionB) {
      alert("Question and both options are required.");
      return;
    }

    const fingerprint = createQuestionFingerprint({
      text,
      optionA,
      optionB
    });

    setIsSaving(true);

    try {
      await updateDoc(doc(db, "submittedQuestions", editingSubmissionId), {
        text,
        category,
        fingerprint,
        options: [
          { id: "a", text: optionA },
          { id: "b", text: optionB }
        ],
        editedBy: user?.email ?? null,
        editedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });

      cancelEditingSubmission();
      await loadSubmissions(true);
    } catch (error) {
      alert(`Could not save edit: ${getErrorMessage(error)}`);
    } finally {
      setIsSaving(false);
    }
  }

  async function updateDrafts(status: "published" | "rejected") {
    if (selectedDraftIds.length === 0) return;

    setIsSaving(true);

    await Promise.all(
      selectedDraftIds.map((id) =>
        updateDoc(doc(db, "questions", id), {
          status,
          reviewedAt: serverTimestamp(),
          reviewedBy: user?.email ?? null,
          updatedAt: serverTimestamp()
        })
      )
    );

    await loadDrafts(true);
    setIsSaving(false);
  }

  async function approveSubmissions() {
    if (selectedSubmissionIds.length === 0) return;

    setIsSaving(true);

    const selected = submissions.filter((item) =>
      selectedSubmissionIds.includes(item.id)
    );

    await Promise.all(
      selected.map(async (submission) => {
        const optionA = submission.options[0]?.text ?? "";
        const optionB = submission.options[1]?.text ?? "";
        const fingerprint =
          submission.fingerprint ||
          createQuestionFingerprint({
            text: submission.text,
            optionA,
            optionB
          });

        await addDoc(collection(db, "questions"), {
          text: submission.text,
          category: submission.category,
          options: submission.options,
          status: "published",
          source: "user_submitted",
          submittedQuestionId: submission.id,
          approvedBy: user?.email ?? null,
          fingerprint,
          randomKey: Math.random(),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });

        await updateDoc(doc(db, "submittedQuestions", submission.id), {
          status: "approved",
          fingerprint,
          reviewedAt: serverTimestamp(),
          reviewedBy: user?.email ?? null,
          updatedAt: serverTimestamp()
        });
      })
    );

    await loadSubmissions(true);
    setIsSaving(false);
  }

  async function rebuildQuestionPacks() {
    setIsSaving(true);
    setLoadError("");
  
    try {
      const result = await rebuildQuestionPacksFunction({
        category: "all"
      });
  
      alert(
        [
          "Question packs rebuilt.",
          "",
          ...result.data.results.map(
            (item) =>
              `${item.category}: ${item.questionCount} questions, ${item.packCount} packs`
          )
        ].join("\n")
      );
    } catch (error) {
      setLoadError(`Could not rebuild packs: ${getErrorMessage(error)}`);
    } finally {
      setIsSaving(false);
    }
  }

  async function rejectSubmissions() {
    if (selectedSubmissionIds.length === 0) return;

    setIsSaving(true);

    await Promise.all(
      selectedSubmissionIds.map((id) =>
        updateDoc(doc(db, "submittedQuestions", id), {
          status: "rejected",
          reviewedAt: serverTimestamp(),
          reviewedBy: user?.email ?? null,
          updatedAt: serverTimestamp()
        })
      )
    );

    await loadSubmissions(true);
    setIsSaving(false);
  }

  if (isLoading && !user) {
    return (
      <main className="page">
        <section className="card center">
          <p className="muted">Loading...</p>
        </section>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="page">
        <section className="card hero">
          <h1>You vs Everyone Admin</h1>
          <p>Sign in to review questions.</p>
          <button onClick={login}>Sign in with Google</button>
        </section>
      </main>
    );
  }

  if (!isAdmin) {
    return (
      <main className="page">
        <section className="card hero">
          <h1>Access denied</h1>
          <p className="muted">
            Signed in as {user.email}. This account is not authorized.
          </p>
          <button onClick={() => signOut(auth)}>Sign out</button>
        </section>
      </main>
    );
  }

  return (
    <main className="page">
      <header className="topbar">
        <div>
          <h1>Question Admin</h1>
          <p className="muted">Signed in as {user.email}</p>
          <p className="muted">Firebase project: {firebaseProjectId}</p>
        </div>

        <button className="secondary" onClick={() => signOut(auth)}>
          Sign out
        </button>
      </header>

      {loadError ? (
        <section className="card" style={{ marginBottom: 18 }}>
          <p style={{ color: "#dc2626", fontWeight: 900 }}>{loadError}</p>
        </section>
      ) : null}

      <section className="tabs">
        <button
          className={tab === "drafts" ? "" : "secondary"}
          onClick={() => setTab("drafts")}
        >
          AI Drafts ({drafts.length})
        </button>

        <button
          className={tab === "submissions" ? "" : "secondary"}
          onClick={() => setTab("submissions")}
        >
          User Submissions ({submissions.length})
        </button>

        <button
          className={tab === "serverConfig" ? "" : "secondary"}
          onClick={() => setTab("serverConfig")}
        >
          Server Config
        </button>
      </section>

      {tab !== "serverConfig" ? (
        <section className="toolbar card">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search question or option..."
          />

          <select
            value={categoryFilter}
            onChange={(event) => setCategoryFilter(event.target.value)}
          >
            <option value="all">All categories</option>
            {CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>

          {tab === "drafts" ? (
            <select
              value={maxScoreFilter}
              onChange={(event) => setMaxScoreFilter(event.target.value)}
            >
              <option value="all">All scores</option>
              <option value="80">Score ≤ 80</option>
              <option value="70">Score ≤ 70</option>
              <option value="60">Score ≤ 60</option>
              <option value="40">Score ≤ 40</option>
            </select>
          ) : null}

          {tab === "submissions" ? (
            <select
              value={submissionStatusFilter}
              onChange={(event) =>
                setSubmissionStatusFilter(
                  event.target.value as SubmissionStatusFilter
                )
              }
            >
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="all">All</option>
            </select>
          ) : null}

          {tab === "drafts" ? (
            <>
              <button className="secondary" onClick={toggleAllVisibleDrafts}>
                {allVisibleDraftsSelected ? "Clear Visible" : "Select Visible"}
              </button>

              <button className="secondary" onClick={() => loadDrafts(true)}>
                Refresh
              </button>

              <button
                disabled={selectedDraftIds.length === 0 || isSaving}
                onClick={() => updateDrafts("published")}
              >
                Approve ({selectedDraftIds.length})
              </button>

              <button
                className="danger"
                disabled={selectedDraftIds.length === 0 || isSaving}
                onClick={() => updateDrafts("rejected")}
              >
                Reject ({selectedDraftIds.length})
              </button>
            </>
          ) : (
            <>
              <button
                className="secondary"
                onClick={toggleAllVisibleSubmissions}
              >
                {allVisibleSubmissionsSelected
                  ? "Clear Visible"
                  : "Select Visible"}
              </button>

              <button className="secondary" onClick={() => loadSubmissions(true)}>
                Refresh
              </button>

              <button
                disabled={selectedSubmissionIds.length === 0 || isSaving}
                onClick={approveSubmissions}
              >
                Approve ({selectedSubmissionIds.length})
              </button>

              <button
                className="danger"
                disabled={selectedSubmissionIds.length === 0 || isSaving}
                onClick={rejectSubmissions}
              >
                Reject ({selectedSubmissionIds.length})
              </button>
            </>
          )}
        </section>
      ) : null}

      {tab === "serverConfig" ? (
        <section className="card">
          <h2>Server Config</h2>
          <p className="muted">
            These values are read by Cloud Functions and do not require an app
            rebuild.
          </p>
          <button disabled={isSaving} onClick={rebuildQuestionPacks}>
            {isSaving ? "Rebuilding..." : "Rebuild Question Packs"}
          </button>

          <label className="formRow">
            <span>Submissions enabled</span>
            <input
              type="checkbox"
              checked={serverConfig.submissionsEnabled}
              onChange={(event) =>
                setServerConfig((current) => ({
                  ...current,
                  submissionsEnabled: event.target.checked
                }))
              }
            />
          </label>

          <label className="formRow">
            <span>Max submissions per day</span>
            <input
              type="number"
              value={serverConfig.maxSubmissionsPerDay}
              onChange={(event) =>
                setServerConfig((current) => ({
                  ...current,
                  maxSubmissionsPerDay: Number(event.target.value)
                }))
              }
            />
          </label>

          <label className="formRow">
            <span>Min seconds between submissions</span>
            <input
              type="number"
              value={serverConfig.minSecondsBetweenSubmissions}
              onChange={(event) =>
                setServerConfig((current) => ({
                  ...current,
                  minSecondsBetweenSubmissions: Number(event.target.value)
                }))
              }
            />
          </label>

          <label className="formRow">
            <span>Rejected submission retention days</span>
            <input
              type="number"
              value={serverConfig.rejectedSubmissionRetentionDays}
              onChange={(event) =>
                setServerConfig((current) => ({
                  ...current,
                  rejectedSubmissionRetentionDays: Number(event.target.value)
                }))
              }
            />
          </label>

          <label className="formRow">
            <span>Analytics retention days</span>
            <input
              type="number"
              value={serverConfig.analyticsRetentionDays}
              onChange={(event) =>
                setServerConfig((current) => ({
                  ...current,
                  analyticsRetentionDays: Number(event.target.value)
                }))
              }
            />
          </label>

          <button disabled={isSaving} onClick={saveServerConfig}>
            {isSaving ? "Saving..." : "Save Server Config"}
          </button>
        </section>
      ) : null}

      {tab === "drafts" ? (
        <>
          <p className="muted">
            {visibleDrafts.length} shown · {drafts.length} loaded
          </p>

          <section className="grid">
            {visibleDrafts.map((draft) => {
              const selected = selectedDraftIds.includes(draft.id);

              return (
                <article
                  key={draft.id}
                  className={`question-card ${selected ? "selected" : ""}`}
                  onClick={() => toggleDraftSelected(draft.id)}
                >
                  <div className="row">
                    <span className="pill">{draft.category}</span>
                    <span className="score">
                      Score {draft.qualityScore ?? "N/A"}
                    </span>
                  </div>

                  <h2>{draft.text}</h2>

                  <div className="option">
                    <strong>A</strong>
                    <span>{draft.options[0]?.text}</span>
                  </div>

                  <div className="option">
                    <strong>B</strong>
                    <span>{draft.options[1]?.text}</span>
                  </div>

                  {draft.fingerprint ? (
                    <p className="batch">Fingerprint: {draft.fingerprint}</p>
                  ) : null}
                </article>
              );
            })}
          </section>

          {hasMoreDrafts ? (
            <div className="loadMore">
              <button disabled={isLoading} onClick={() => loadDrafts(false)}>
                {isLoading ? "Loading..." : "Load More"}
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "submissions" ? (
        <>
          <p className="muted">
            {visibleSubmissions.length} shown · {submissions.length} loaded
          </p>

          <section className="grid">
            {visibleSubmissions.map((submission) => {
              const selected = selectedSubmissionIds.includes(submission.id);
              const isEditing = editingSubmissionId === submission.id;

              return (
                <article
                  key={submission.id}
                  className={`question-card ${selected ? "selected" : ""}`}
                >
                  {isEditing ? (
                    <>
                      <label className="editLabel">Question</label>
                      <textarea
                        value={editableSubmission.text}
                        onChange={(event) =>
                          setEditableSubmission((current) => ({
                            ...current,
                            text: event.target.value
                          }))
                        }
                      />

                      <label className="editLabel">Category</label>
                      <select
                        value={editableSubmission.category}
                        onChange={(event) =>
                          setEditableSubmission((current) => ({
                            ...current,
                            category: event.target.value
                          }))
                        }
                      >
                        {CATEGORIES.map((category) => (
                          <option key={category} value={category}>
                            {category}
                          </option>
                        ))}
                      </select>

                      <label className="editLabel">Option A</label>
                      <input
                        value={editableSubmission.optionA}
                        onChange={(event) =>
                          setEditableSubmission((current) => ({
                            ...current,
                            optionA: event.target.value
                          }))
                        }
                      />

                      <label className="editLabel">Option B</label>
                      <input
                        value={editableSubmission.optionB}
                        onChange={(event) =>
                          setEditableSubmission((current) => ({
                            ...current,
                            optionB: event.target.value
                          }))
                        }
                      />

                      <div className="row">
                        <button disabled={isSaving} onClick={saveEditedSubmission}>
                          Save Edit
                        </button>
                        <button
                          className="secondary"
                          onClick={cancelEditingSubmission}
                        >
                          Cancel
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div
                        onClick={() => toggleSubmissionSelected(submission.id)}
                      >
                        <div className="row">
                          <span className="pill">{submission.category}</span>
                          <span className="score">
                            Status: {submission.status}
                          </span>
                        </div>

                        <h2>{submission.text}</h2>

                        <div className="option">
                          <strong>A</strong>
                          <span>{submission.options[0]?.text}</span>
                        </div>

                        <div className="option">
                          <strong>B</strong>
                          <span>{submission.options[1]?.text}</span>
                        </div>

                        {submission.submittedBy ? (
                          <p className="batch">
                            Submitted by: {submission.submittedBy}
                          </p>
                        ) : null}

                        {submission.fingerprint ? (
                          <p className="batch">
                            Fingerprint: {submission.fingerprint}
                          </p>
                        ) : null}
                      </div>

                      <button
                        className="secondary"
                        onClick={() => startEditingSubmission(submission)}
                      >
                        Edit
                      </button>
                    </>
                  )}
                </article>
              );
            })}
          </section>

          {hasMoreSubmissions ? (
            <div className="loadMore">
              <button
                disabled={isLoading}
                onClick={() => loadSubmissions(false)}
              >
                {isLoading ? "Loading..." : "Load More"}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
