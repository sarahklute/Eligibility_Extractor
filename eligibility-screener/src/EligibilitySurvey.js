import React, { useState, useEffect, useCallback, useRef } from "react";
import * as SurveyCore from "survey-core";
import { Survey } from "survey-react-ui";
import surveyData from "./config/eligibility_config.json";
import "survey-core/defaultV2.min.css";

const EligibilityScreener = () => {
  const { programs = [], criteria = [], questions = [] } = surveyData || {};

  const userResponses = useRef({});
  const [eligiblePrograms, setEligiblePrograms] = useState(
    new Set(programs.map((p) => p.id))
  );
  const [surveyCompleted, setSurveyCompleted] = useState(false);
  const [surveyModel, setSurveyModel] = useState(null);
  const [evaluationPending, setEvaluationPending] = useState(false);

  const meetsCriterion = useCallback((criterion, answer, householdSize) => {
    if (!criterion) return true;

    if (criterion.threshold_by_household_size && householdSize) {
      const threshold = criterion.threshold_by_household_size[householdSize];
      return criterion.comparison === "<=" ? answer <= threshold : answer >= threshold;
    }

    if (criterion.threshold !== undefined) {
      return criterion.comparison === "<=" ? answer <= criterion.threshold : answer >= criterion.threshold;
    }

    if (criterion.options) {
      return criterion.options.includes(answer);
    }

    return true;
  }, []);

  const evaluateEligibility = useCallback(() => {
    if (!surveyModel) {
      console.warn("Survey model not initialized. Deferring evaluation.");
      setEvaluationPending(true);
      return;
    }

    const programEligibilityMap = {};

    // Get the state from user responses
    const userState = userResponses.current["What state do you live in?"]; // Get state residency response

    // Loop through programs and evaluate eligibility
    programs.forEach((program) => {
      programEligibilityMap[program.id] = true;

      // Check if the program has a state residency requirement
      const stateResidencyCriteria = program.criteria_ids
        .map((criteriaId) => criteria.find((criterion) => criterion.id === criteriaId))
        .find((criterion) => criterion.category === "requirements" && criterion.options);

      // If state residency is required, validate the user's state
      if (stateResidencyCriteria) {
        const requiredStates = stateResidencyCriteria.options;

        // If the user's state is not in the list of required states, mark the program as ineligible
        if (!requiredStates.includes(userState)) {
          console.log(`User does not meet state residency requirement for program "${program.id}".`);
          programEligibilityMap[program.id] = false; // Mark program as ineligible
          return;
        }
      }

      // Evaluate the program's criteria (income, SSN, etc.)
      for (const criteria_id of program.criteria_ids) {
        if (!programEligibilityMap[program.id]) break;

        const criterion = criteria.find((c) => c.id === criteria_id);
        const question = questions.find((q) =>
          q.criteria_impact.some((ci) => ci.criteria_id === criteria_id)
        );

        if (!question) {
          console.warn(`No question found for criterion "${criteria_id}" in program "${program.id}". Skipping.`);
          continue;
        }

        const questionName = question.question;
        const userAnswer = userResponses.current[questionName];
        const householdSize = userResponses.current["What is your household size?"];

        if (userAnswer === undefined) {
          console.log(`Awaiting answer for criterion "${criteria_id}" in program "${program.id}".`);
          continue;
        }

        const isPass = meetsCriterion(criterion, userAnswer, householdSize);

        if (!isPass) {
          console.log(`Criterion "${criteria_id}" failed for program "${program.id}". Marking ineligible.`);
          programEligibilityMap[program.id] = false;
        }
      }
    });

    const updatedEligiblePrograms = new Set(
      Object.keys(programEligibilityMap).filter((programId) => programEligibilityMap[programId])
    );
    setEligiblePrograms(updatedEligiblePrograms);

    if (updatedEligiblePrograms.size === 0) {
      console.log("No eligible programs remaining. Ending survey.");

      // Hide all existing questions
      surveyModel.getAllQuestions().forEach((q) => (q.visible = false));

      // Dynamically add a new page with the no-eligibility message
      const noEligibilityPage = surveyModel.addNewPage("NoEligibilityPage");
      noEligibilityPage.addNewQuestion("html", "noEligibilityMessage").html = `
        <h3>Unfortunately, you are not eligible for any programs.</h3>
        <p>Based on your responses, we couldn't determine eligibility for any programs at this time.</p>
      `;

      // Navigate to the newly added page
      surveyModel.currentPage = noEligibilityPage;

      // Disable navigation buttons (including "Complete")
      surveyModel.showNavigationButtons = false;

      return;
    } else if (updatedEligiblePrograms.size > 0 && surveyModel.isLastPage) {
      console.log("Eligible programs found. Displaying eligible programs.");

      // Hide all existing questions
      surveyModel.getAllQuestions().forEach((q) => (q.visible = false));

      // Dynamically add a new page with the list of eligible programs
      const eligibleProgramsPage = surveyModel.addNewPage("EligibleProgramsPage");
      eligibleProgramsPage.addNewQuestion("html", "eligibleProgramsMessage").html = `
        <div style="text-align: center; padding: 20px;">
          <h3 style="font-size: 1.8rem; color: #2c3e50;">Congratulations! You are eligible for the following programs:</h3>
          <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; display: inline-block; margin-top: 10px;">
            <ul style="list-style: none; padding: 0; margin: 0; text-align: left;">
              ${Array.from(updatedEligiblePrograms)
                .map(
                  (programId) => {
                    const program = programs.find((p) => p.id === programId);
                    return `
                      <li style="font-size: 1.2rem; margin: 5px 0; display: flex; align-items: center;">
                        <span style="margin-right: 8px; color: #2ecc71;">✔</span>
                        ${program?.name || "Unknown Program"}
                      </li>
                    `;
                  }
                )
                .join("")}
            </ul>
          </div>
        </div>
      `;

      // Navigate to the newly added page
      surveyModel.currentPage = eligibleProgramsPage;

      // Disable navigation buttons (including "Complete")
      surveyModel.showNavigationButtons = false;

      return;
    }

    console.log("Eligible programs after evaluation:", updatedEligiblePrograms);
  }, [programs, criteria, questions, meetsCriterion, surveyModel]);

  const initializeSurveyModel = useCallback(() => {
    console.log("Initializing survey model...");
    
    const surveyQuestions = questions.map((question) => {
      let choices = [];
      
      // Handle dropdown options specifically
      if (question.input_type === "dropdown") {
        choices = question.options || [];  // Make sure the options are passed correctly
      } else if (question.input_type === "radio") {
        choices = question.options ? question.options : ["Yes", "No"];  // Default for radio
      }

      return {
        name: question.question,
        title: question.question,
        type: question.type === "boolean" ? "radiogroup" : question.type === "number" ? "text" : "dropdown",
        isRequired: true,
        choices: choices,  // Ensure the choices are passed for dropdown
        inputType: question.type === "number" ? "number" : undefined,
      };
    });

    const survey = new SurveyCore.Model({
      questions: surveyQuestions,
      questionsOnPageMode: "single",
      showQuestionNumbers: "off",
      progressBarType: "questions", // Add progress bar based on the number of questions answered
    });

    // Ensure progress bar is visible
    survey.showProgressBar = "top"; // Display the progress bar at the top of the survey

    survey.completedHtml = "<h3>Survey Complete</h3><p>Your eligible programs will be displayed here.</p>";

    survey.onValueChanged.add((sender, options) => {
      if (surveyCompleted) {
        console.log("Survey already completed. Ignoring value change.");
        return;
      }

      const { name, value } = options;
      userResponses.current[name] = value;
      console.log("User responses updated:", userResponses.current);
      evaluateEligibility();
    });

    survey.onComplete.add(() => {
      console.log("Survey complete. Final user responses:", { ...userResponses.current });
    });

    return survey;
  }, [questions, evaluateEligibility, surveyCompleted]);

  useEffect(() => {
    if (!surveyModel) {
      console.log("Setting survey model...");
      const survey = initializeSurveyModel();
      setSurveyModel(survey); // Only set the survey model when it's initialized
    }
  }, [initializeSurveyModel, surveyModel]);

  return (
    <div>
      <h1>Eligibility Screener</h1>
      {surveyModel ? <Survey model={surveyModel} /> : <p>Loading...</p>}
    </div>
  );
};

export default EligibilityScreener;
