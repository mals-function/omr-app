export function optionsFor(type) {
  if (type === 'TF') return ['T', 'F'];

  return ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
}

export function questions(exam) {
  if (!exam) return [];

  return exam.sections.flatMap((section, sectionIndex) =>
    section.key.map((correct, questionIndex) => ({
      sectionIndex,
      sectionName: section.name,
      questionIndex,
      correct,
      options: optionsFor(section.type),
      points: section.points,
      penalty: section.penalty
    }))
  );
}

export function buildSections(drafts) {
  if (!drafts.length || drafts.length > 5) {
    throw new Error('Use between 1 and 5 sections.');
  }

  const sections = drafts.map(draft => {
    const name = draft.name.trim();

    const key = draft.keyText
      .toUpperCase()
      .trim()
      .split(/[\s,;]+/)
      .filter(Boolean);

    const points = Number(draft.points);
    const penalty = Number(draft.penalty);

    if (!name || name.length > 60) {
      throw new Error('Each section needs a name of up to 60 characters.');
    }

    if (!['MCQ', 'TF'].includes(draft.type)) {
      throw new Error('Invalid section type.');
    }

    if (
      !key.length ||
      key.some(answer => !optionsFor(draft.type).includes(answer))
    ) {
      throw new Error(`Invalid answer key in ${name}.`);
    }

    if (
      !Number.isFinite(points) ||
      points <= 0 ||
      points > 100 ||
      !Number.isFinite(penalty) ||
      penalty < 0 ||
      penalty > 100
    ) {
      throw new Error('Points must be above 0–100; penalty must be 0–100.');
    }

    return {
      name,
      type: draft.type,
      key,
      points,
      penalty
    };
  });

  const count = sections.reduce(
    (total, section) => total + section.key.length,
    0
  );

  if (sections.some(section => section.key.length > 100)) {
    throw new Error('Each section supports a maximum of 100 questions.');
  }

  return sections;
}

export function layoutSignature(sections) {
  return JSON.stringify(
    sections.map(section => ({
      type: section.type,
      count: section.key.length
    }))
  );
}

export function grade(answers, exam) {
  const items = questions(exam);

  if (!items.length || answers.length !== items.length) {
    throw new Error('Answer count does not match the exam.');
  }

  let total = 0;
  let maximum = 0;

  const correct = [];

  items.forEach((item, index) => {
    const answer = answers[index];

    if (
      answer !== '' &&
      answer !== 'MULTIPLE' &&
      !item.options.includes(answer)
    ) {
      throw new Error(`Review question ${index + 1}.`);
    }

    maximum += item.points;

    const isCorrect = answer === item.correct;
    correct.push(isCorrect);

    if (isCorrect) {
      total += item.points;
    } else if (answer !== '') {
      total -= item.penalty;
    }
  });

  const score = Math.max(0, Math.round(total * 100) / 100);
  const maxScore = Math.round(maximum * 100) / 100;

  return {
    score,
    maxScore,
    percentage: Math.round(score / maxScore * 10000) / 100,
    correct
  };
}