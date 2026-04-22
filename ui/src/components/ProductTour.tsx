import { useState, useEffect } from "react";
import { TourTooltip } from "./TourTooltip";

interface TourStep {
  id: string;
  targetSelector: string;
  title: string;
  body: string;
}

const TOUR_STEPS: TourStep[] = [
  {
    id: "decisions",
    targetSelector: '[data-tour="decisions"]',
    title: "Your Decision Inbox",
    body: "Your agents draft decisions; you approve or reject. This is where 90% of your time here will go.",
  },
  {
    id: "weekly-wrap",
    targetSelector: '[data-tour="weekly-wrap"]',
    title: "Weekly Wrap",
    body: "Every Friday, your Chief of Staff drafts a weekly wrap. Shipped, stalled, and what to focus on next.",
  },
  {
    id: "memory",
    targetSelector: '[data-tour="memory"]',
    title: "Company Memory",
    body: "Anything you learn — about a customer, a market, a process — goes here. Your agents read it before every task.",
  },
  {
    id: "departments",
    targetSelector: '[data-tour="departments"]',
    title: "Departments",
    body: "You have four departments: CoS, Growth, Content, Finance. Each has a pre-briefed head. Click through to see what they're working on.",
  },
];

interface ProductTourProps {
  userId: string;
  companyId: string;
}

export function ProductTour({ userId, companyId }: ProductTourProps) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set());
  const [isVisible, setIsVisible] = useState(false);

  const storageKey = `founderos:tour:completed:${userId}`;

  // Check if tour has been completed
  useEffect(() => {
    const completed = localStorage.getItem(storageKey);
    if (!completed) {
      setIsVisible(true);
    }
  }, [storageKey]);

  // Skip current step if target doesn't exist
  useEffect(() => {
    if (!isVisible || currentStepIndex >= TOUR_STEPS.length) return;

    const checkTarget = () => {
      const step = TOUR_STEPS[currentStepIndex];
      const target = document.querySelector(step.targetSelector);

      if (!target && completedSteps.size < TOUR_STEPS.length) {
        // Target doesn't exist, mark as completed and move to next
        const newCompleted = new Set(completedSteps);
        newCompleted.add(currentStepIndex);
        setCompletedSteps(newCompleted);
        setCurrentStepIndex((prev) => prev + 1);
      }
    };

    const timer = setTimeout(checkTarget, 100);
    return () => clearTimeout(timer);
  }, [currentStepIndex, completedSteps, isVisible]);

  const handleNext = () => {
    setCurrentStepIndex((prev) => prev + 1);
  };

  const handleBack = () => {
    setCurrentStepIndex((prev) => Math.max(0, prev - 1));
  };

  const handleSkip = () => {
    localStorage.setItem(storageKey, "true");
    setIsVisible(false);
  };

  // Tour complete
  if (currentStepIndex >= TOUR_STEPS.length) {
    localStorage.setItem(storageKey, "true");
    return null;
  }

  if (!isVisible) {
    return null;
  }

  const currentStep = TOUR_STEPS[currentStepIndex];

  return (
    <TourTooltip
      targetSelector={currentStep.targetSelector}
      title={currentStep.title}
      body={currentStep.body}
      step={currentStepIndex + 1}
      total={TOUR_STEPS.length}
      onNext={handleNext}
      onSkip={handleSkip}
      onBack={currentStepIndex > 0 ? handleBack : undefined}
    />
  );
}
