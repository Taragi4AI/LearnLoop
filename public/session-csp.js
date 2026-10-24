// Session-only learning package (CSP).
//
// This module deliberately owns no storage and makes no network requests. Its
// only evidence is the active lecture's already-fetched transcript segments and
// the learner activity handed to it by learn.js. Changing or reloading a
// lecture therefore drops the package naturally.

import { el } from './shared.js';

const STOP_WORDS = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'what', 'when', 'where', 'which', 'from', 'into', 'about', 'your', 'does', 'have', 'will', 'would', 'could', 'should', 'please', 'explain', 'lecture']);

function cleanText(value, max = 260) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function words(value) {
  return cleanText(value, 1000).toLowerCase().match(/[\p{L}\p{N}']+/gu)?.filter((word) => word.length > 2 && !STOP_WORDS.has(word)) || [];
}

function shortTopic(value, fallback = 'lecture concept') {
  const text = cleanText(value, 120);
  const clause = text.split(/[.?!;:]/)[0].trim();
  return (clause.split(/\s+/).slice(0, 8).join(' ') || fallback).slice(0, 72);
}

function isSubstantiveQuestion(question) {
  const text = cleanText(question, 600);
  if (text.length < 8 || words(text).length < 2) return false;
  // Voice-control, wake-word, and bookmark requests are not learning
  // questions—even if the transcription service adds a question mark.
  if (/\b(?:hey\s+jarvis|are\s+you\s+listening|stop(?:\s+it)?|start\s+listening|bookmark|set\s+up|save\s+(?:this|a)|pause|play|rewind|forward|mute|volume|speed|timestamp)\b/i.test(text)) return false;
  return /\b(what|why|how|when|where|which|who|can you|could you|clarify|explain|re-?explain|simpl(?:ify|er)|break.*down|help me understand|meaning|matlab|kya)\b/i.test(text);
}

function isUsableSegment(segment) {
  return Number.isInteger(Number(segment?.seq)) && Number(segment.seq) >= 0 &&
    Number.isFinite(Number(segment?.start)) && Number(segment.start) >= 0 &&
    Number.isFinite(Number(segment?.end)) && Number(segment.end) >= Number(segment.start) &&
    cleanText(segment?.text).length > 0;
}

export function createSessionCsp({ container: initialContainer = null, seek, formatTime, isActiveLecture }) {
  let container = initialContainer;
  let lectureId = null;
  let state = null;
  let queuedQuestions = [];

  function citationFor(segment) {
    // Newer transcript responses expose a persisted segment id. Older active
    // servers expose seq/start/end only, so retain compatibility by deriving a
    // stable label from those already-validated transcript record fields.
    return {
      id: typeof segment.id === 'string' && segment.id.trim()
        ? segment.id.trim()
        : `${lectureId}:segment:${Number(segment.seq)}:${Number(segment.start).toFixed(3)}`,
      seq: Number(segment.seq), start: Number(segment.start), end: Number(segment.end),
      text: cleanText(segment.text, 900),
    };
  }

  function evidenceForText(text) {
    if (!state) return null;
    const terms = new Set(words(text));
    let best = null;
    let score = 0;
    for (const citation of state.citations) {
      const matches = words(citation.text).filter((word) => terms.has(word)).length;
      if (matches > score) { score = matches; best = citation; }
    }
    return score ? best : null;
  }

  function addReview(item) {
    if (!state || state.review.some((existing) => existing.key === item.key)) return;
    state.review.push({ reviewed: false, ...item });
  }

  function syncQuestionReview(question) {
    const citation = evidenceForText(question.text);
    addReview({
      key: `question:${question.id}`, source: 'learner question', topic: question.text,
      lectureId, citation, questionId: question.id,
    });
  }

  function buildGeneralFaqs() {
    const count = Math.min(3, state.citations.length);
    const stride = Math.max(1, Math.floor(state.citations.length / Math.max(count, 1)));
    return state.citations.filter((_citation, index) => index % stride === 0).slice(0, count).map((citation, index) => ({
      id: `general:${citation.id}`,
      question: `What does the lecture say about ${shortTopic(citation.text, 'this concept')}?`,
      answer: `The lecture explains: ${citation.text}`,
      source: 'Lecture evidence', citations: [citation], index,
    }));
  }

  function buildQuestionFaq(question) {
    const citation = evidenceForText(question.text);
    if (!citation) return null;
    return {
      id: `question:${question.id}`, question: question.text,
      answer: `The lecture explains: ${citation.text}`,
      source: 'Lecture evidence', citations: [citation],
    };
  }

  function buildQuiz() {
    const citations = state.citations;
    const prior = new Map((state.quiz || []).map((question) => [question.id, question]));
    const questionSeeds = state.questions.map((question) => ({ question, citation: evidenceForText(question.text) }))
      .filter((seed) => seed.citation);
    // Learner questions drive the package whenever possible. The fallback only
    // covers a learner who has not asked a question yet.
    const seeds = questionSeeds.length ? questionSeeds : citations.slice(0, 3).map((citation) => ({ citation, question: null }));
    const questions = [];
    for (const seed of seeds) {
      if (questions.length >= 3) break;
      const correctCitation = seed.citation;
      const alternatives = citations.filter((citation) => citation.id !== correctCitation.id)
        .slice(0, 2).map((citation) => citation.text);
      const learnerQuestion = seed.question?.text || null;
      const intent = learnerQuestion && /\bwhy\b/i.test(learnerQuestion) ? 'why' :
        learnerQuestion && /\bhow\b/i.test(learnerQuestion) ? 'how' :
        learnerQuestion && /\b(clarify|simpl(?:ify|er)|break.*down|explain)\b/i.test(learnerQuestion) ? 'clarification' : 'concept';
      const id = `quiz:${seed.question?.id || correctCitation.id}`;
      const preserved = prior.get(id);
      const prompt = learnerQuestion
        ? (intent === 'why' ? `Which lecture statement best helps answer why: “${learnerQuestion}”?` :
          intent === 'how' ? `Which lecture statement best helps explain how: “${learnerQuestion}”?` :
          `Which lecture statement best clarifies: “${learnerQuestion}”?`)
        : `Which statement is supported by the lecture near ${formatTime(correctCitation.start)}?`;
      // A one-segment lecture can only support a short-answer item honestly.
      if (!alternatives.length) {
        questions.push({ id, type: 'short',
          prompt: learnerQuestion ? `In a short phrase, what lecture point helps answer: “${learnerQuestion}”?` : `In a short phrase, recall the point made at ${formatTime(correctCitation.start)}.`,
          correct: correctCitation.text, rationale: correctCitation.text, citations: [correctCitation], attempts: [] });
        const generated = questions.at(-1);
        if (preserved) Object.assign(generated, { attempts: preserved.attempts || [], currentAnswer: preserved.currentAnswer });
        continue;
      }
      const options = [correctCitation.text, ...alternatives].map((text, index) => ({ text, correct: index === 0 }));
      // Deterministic rotation prevents the correct option always appearing first.
      const rotation = questions.length % options.length;
      const rotated = options.slice(rotation).concat(options.slice(0, rotation));
      questions.push({ id, type: 'choice', prompt,
        options: rotated, correct: rotated.findIndex((option) => option.correct),
        rationale: correctCitation.text, citations: [correctCitation], attempts: [], selected: null });
      const generated = questions.at(-1);
      if (preserved) Object.assign(generated, { attempts: preserved.attempts || [], selected: preserved.selected, currentAnswer: preserved.currentAnswer });
    }
    return questions;
  }

  function generateSection(name) {
    if (!state) return;
    try {
      if (name === 'faqs') state.generalFaqs = buildGeneralFaqs();
      if (name === 'quiz') state.quiz = buildQuiz();
      delete state.failures[name];
    } catch {
      state.failures[name] = 'This section could not be generated from the processed transcript.';
    }
  }

  function failureBlock(name, label) {
    const block = el('div', { className: 'csp-failure' });
    block.append(el('p', { className: 'err', textContent: state.failures[name] }));
    const retry = el('button', { className: 'ctl small', type: 'button', textContent: `Retry ${label}` });
    retry.addEventListener('click', () => { generateSection(name); render(); });
    block.append(retry);
    return block;
  }

  function renderCitation(citation) {
    const button = el('button', { className: 'csp-source', type: 'button',
      textContent: `Source · ${formatTime(citation.start)}`,
      title: citation.text, 'aria-label': `Replay source at ${formatTime(citation.start)}` });
    button.addEventListener('click', () => {
      if (state && lectureId === state.lectureId && isActiveLecture?.(lectureId)) seek(citation.start);
    });
    return button;
  }

  function evidenceLine(citations) {
    const line = el('div', { className: 'csp-evidence' });
    if (!citations?.length) {
      line.append(el('span', { className: 'muted', textContent: 'No validated lecture evidence.' }));
    } else {
      line.append(el('span', { className: 'csp-citation-id', textContent: citations.map((c) => c.id).join(', ') }));
      citations.forEach((citation) => line.append(renderCitation(citation)));
    }
    return line;
  }

  function renderQuizQuestion(question) {
    const card = el('article', { className: 'csp-item csp-quiz-question' });
    card.append(el('p', { className: 'csp-question', textContent: question.prompt }));
    if (question.type === 'choice') {
      const choices = el('div', { className: 'csp-choices', role: 'group', 'aria-label': question.prompt });
      question.options.forEach((option, index) => {
        const button = el('button', { className: 'ctl small', type: 'button', textContent: option.text });
        button.addEventListener('click', () => submitChoice(question.id, index));
        choices.append(button);
      });
      card.append(choices);
    } else {
      const input = el('input', { className: 'csp-short-answer', type: 'text', placeholder: 'Your answer' });
      const submit = el('button', { className: 'ctl small', type: 'button', textContent: 'Check answer' });
      submit.addEventListener('click', () => submitShort(question.id, input.value));
      card.append(input, submit);
    }
    const latest = question.attempts.at(-1);
    if (latest) {
      const feedback = el('div', { className: latest.correct ? 'csp-feedback ok' : 'csp-feedback err' });
      feedback.append(el('strong', { textContent: latest.correct ? 'Correct.' : 'Not yet.' }));
      feedback.append(document.createTextNode(` ${question.rationale}`));
      card.append(feedback);
      if (!latest.correct) {
        const retry = el('button', { className: 'ctl small', type: 'button', textContent: 'Retry' });
        retry.addEventListener('click', () => { question.selected = null; render(); });
        card.append(retry);
      }
    }
    card.append(evidenceLine(question.citations));
    return card;
  }

  function render() {
    if (!container) return;
    container.textContent = '';
    const panel = el('section', { className: 'csp-panel', 'aria-label': 'Session learning package' });
    const head = el('div', { className: 'csp-head' });
    head.append(el('div', {}, el('strong', { textContent: 'Session learning package' }),
      el('p', { className: 'muted', textContent: 'Generated for this processed lecture only. It resets when you switch lectures or reload.' })));
    panel.append(head);
    if (!state) {
      panel.append(el('p', { className: 'muted', textContent: lectureId ? 'Available after this lecture finishes processing.' : 'Load a lecture to begin.' }));
      container.append(panel); return;
    }
    if (!state.citations.length) {
      panel.append(el('p', { className: 'muted', textContent: 'No validated lecture evidence is available in the processed transcript.' }));
    }

    const faqs = el('section', { className: 'csp-section' });
    faqs.append(el('h3', { textContent: 'FAQs' }));
    if (state.failures.faqs) faqs.append(failureBlock('faqs', 'FAQs'));
    (state.generalFaqs || []).forEach((faq) => {
      const item = el('article', { className: 'csp-item' });
      item.append(el('strong', { textContent: faq.question }), el('p', { textContent: faq.answer }),
        el('p', { className: 'csp-source-label', textContent: faq.source }), evidenceLine(faq.citations)); faqs.append(item);
    });
    faqs.append(el('h4', { textContent: 'From your questions' }));
    if (!state.questions.length) faqs.append(el('p', { className: 'muted', textContent: 'Ask a substantive question in Jarvis to add it here for this session.' }));
    const groundedQuestions = state.questions.map((question) => ({ question, faq: buildQuestionFaq(question) }))
      .filter(({ faq }) => faq);
    if (!groundedQuestions.length) faqs.append(el('p', { className: 'muted', textContent: 'No learner questions matched validated lecture evidence yet.' }));
    groundedQuestions.forEach(({ faq }) => {
      const item = el('article', { className: 'csp-item' });
      item.append(el('strong', { textContent: faq.question }), el('p', { textContent: faq.answer }),
        el('p', { className: 'csp-source-label', textContent: faq.source }), evidenceLine(faq.citations)); faqs.append(item);
    });
    // A wrong attempt remains a session learning signal even when the learner
    // later retries successfully, so it belongs in this session's FAQ material.
    (state.quiz || []).filter((question) => question.attempts.some((attempt) => !attempt.correct)).forEach((question) => {
      const item = el('article', { className: 'csp-item' });
      item.append(el('strong', { textContent: `Review from a missed quiz concept: ${shortTopic(question.rationale)}` }),
        el('p', { textContent: question.rationale }),
        el('p', { className: 'csp-source-label', textContent: 'Lecture evidence' }), evidenceLine(question.citations));
      faqs.append(item);
    });
    panel.append(faqs);

    const quiz = el('section', { className: 'csp-section' });
    const quizItems = state.quiz || [];
    const score = quizItems.reduce((sum, question) => sum + (question.attempts.at(-1)?.correct ? 1 : 0), 0);
    quiz.append(el('h3', { textContent: 'Quiz' }), el('p', { className: 'muted', textContent: `Current score: ${score}/${quizItems.length}. Attempts stay in this session only.` }));
    if (state.failures.quiz) quiz.append(failureBlock('quiz', 'quiz'));
    quizItems.forEach((question) => quiz.append(renderQuizQuestion(question)));
    panel.append(quiz);

    const review = el('section', { className: 'csp-section' });
    review.append(el('h3', { textContent: 'Review list' }),
      el('p', { className: 'muted', textContent: 'Missed quiz concepts, your substantive questions, and saved lecture moments.' }));
    if (!state.review.length) review.append(el('p', { className: 'muted', textContent: 'Nothing to review yet.' }));
    state.review.forEach((item) => {
      const row = el('article', { className: `csp-item csp-review${item.reviewed ? ' reviewed' : ''}` });
      row.append(el('span', { className: 'csp-source-label', textContent: item.source }),
        el('p', { textContent: item.topic }), el('p', { className: 'muted', textContent: `Lecture: ${item.lectureId}${Number.isFinite(item.timestamp) ? ` · Moment: ${formatTime(item.timestamp)}` : ''}` }));
      if (item.citation) row.append(evidenceLine([item.citation]));
      const actions = el('div', { className: 'csp-actions' });
      const mark = el('button', { className: 'ctl small', type: 'button', textContent: item.reviewed ? 'Mark unreviewed' : 'Mark reviewed' });
      mark.addEventListener('click', () => { item.reviewed = !item.reviewed; render(); });
      const remove = el('button', { className: 'ctl small', type: 'button', textContent: 'Remove' });
      remove.addEventListener('click', () => { state.review = state.review.filter((entry) => entry !== item); render(); });
      actions.append(mark, remove); row.append(actions); review.append(row);
    });
    panel.append(review);
    container.append(panel);
  }

  function submitChoice(id, selected) {
    const question = state?.quiz.find((entry) => entry.id === id);
    if (!question || !Number.isInteger(selected)) return;
    const correct = selected === question.correct;
    question.selected = selected;
    question.currentAnswer = selected;
    question.attempts.push({ selected, correct });
    if (!correct) addReview({ key: `missed:${question.id}`, source: 'missed quiz concept', topic: shortTopic(question.rationale), lectureId, citation: question.citations[0] });
    render();
  }

  function submitShort(id, answer) {
    const question = state?.quiz.find((entry) => entry.id === id);
    if (!question) return;
    const expected = new Set(words(question.correct));
    const actual = words(answer);
    const correct = actual.length > 0 && actual.filter((word) => expected.has(word)).length >= Math.min(2, expected.size);
    question.currentAnswer = cleanText(answer, 300);
    question.attempts.push({ answer: question.currentAnswer, correct });
    if (!correct) addReview({ key: `missed:${question.id}`, source: 'missed quiz concept', topic: shortTopic(question.rationale), lectureId, citation: question.citations[0] });
    render();
  }

  return {
    setLecture(nextLectureId) {
      if (lectureId === nextLectureId) return;
      lectureId = nextLectureId || null;
      state = null; queuedQuestions = [];
      render();
    },
    activate(nextLectureId, segments) {
      if (!nextLectureId || nextLectureId !== lectureId || state) return;
      const citations = (segments || []).filter(isUsableSegment).map(citationFor);
      state = { lectureId, citations, questions: queuedQuestions.filter((question) => isSubstantiveQuestion(question.text)), review: [], generalFaqs: [], quiz: [], bookmarks: [], failures: {} };
      generateSection('faqs'); generateSection('quiz');
      state.questions.forEach(syncQuestionReview);
      render();
    },
    recordQuestion(text) {
      const question = { id: `q:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`, text: cleanText(text, 600) };
      if (!isSubstantiveQuestion(question.text) || !lectureId) return;
      if (!state) { queuedQuestions.push(question); return; }
      state.questions.push(question); syncQuestionReview(question); generateSection('quiz'); render();
    },
    setBookmarks(bookmarks) {
      if (!state) return;
      const existingKeys = new Set((bookmarks || []).map((bookmark) => `bookmark:${bookmark.id}`));
      state.review = state.review.filter((item) => item.source !== 'saved lecture moment' || existingKeys.has(item.key));
      for (const bookmark of bookmarks || []) {
        const citation = evidenceForText(bookmark.transcript_excerpt || bookmark.title) || state.citations.find((entry) => Math.abs(entry.start - Number(bookmark.timestamp_seconds)) < 1);
        addReview({ key: `bookmark:${bookmark.id}`, source: 'saved lecture moment', topic: bookmark.title || `Moment at ${formatTime(bookmark.timestamp_seconds)}`,
          lectureId, citation: citation || null, timestamp: Number(bookmark.timestamp_seconds) });
      }
      render();
    },
    mount(nextContainer) { container = nextContainer || null; render(); },
    unmount(nextContainer) { if (!nextContainer || container === nextContainer) container = null; },
    clear() { lectureId = null; state = null; queuedQuestions = []; render(); },
  };
}
