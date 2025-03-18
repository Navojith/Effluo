import fs from 'fs';
import { app } from '../config/appConfig.ts';
import { PullRequestService } from '../services/pullRequest.service.ts';
import { CustomError } from '../types/common.d';
import { logger } from '../utils/logger.ts';
import {
  analyzePullRequest,
  analyzePullRequest2,
  analyzeConflicts,
} from '../functions/semantic-conflict-detection/semanticConflictDetection.ts';
import { calculateReviewDifficultyOfPR } from '../functions/workload-calculation/workloadCalculation.ts';
import { PullRequest } from '../entities/pullRequest.entity.ts';
import { AppDataSource } from '../server/server.ts';
import { PrFeedback } from '../entities/prFeedback.entity.ts';
import { prioritizePullRequest } from '../functions/pr-prioritization/pr-prioritization.ts';
import { PRReviewRequestService } from '../services/prReviewRequest.service.ts';
import { PrConflictAnalysisService } from '../services/prConflictAnalysis.service.ts';

const postAIValidationForm = async (
  octokit: any,
  owner: string,
  repo: string,
  issueNumber: number
) => {
  const validationMessage = `
  ✅ **AI Conflict Detection Results** ✅  
  Our AI has analyzed this pull request and found potential **semantic conflicts**.

  ### _What should you do next?_
  📌 Please review the AI's findings and provide feedback by commenting with:
  - \`#Confirm\` → If you agree this is a conflict.
  - \`#NotAConflict\` → If you believe there's no conflict _(please add a brief explanation)_.

  ✍️ _Tip: Reply with one of the above tags as a separate comment._
  `;

  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: validationMessage,
  });

  // Track that we've posted the validation form for this PR
  await PrConflictAnalysisService.trackAnalysis(
    issueNumber,
    owner,
    repo,
    true, // conflicts detected
    true  // validation form posted
  );
};

const logConflictFeedback = async (
  prNumber: number,
  conflictConfirmed: boolean,
  explanation: string | null
) => {
  try {
    const feedback = new PrFeedback();
    feedback.pr_number = prNumber;
    feedback.conflict_confirmed = conflictConfirmed;
    feedback.explanation = explanation;

    const feedbackRepository = AppDataSource.getRepository(PrFeedback);
    await feedbackRepository.save(feedback);

    logger.info('Feedback saved successfully');
  } catch (error) {
    logger.error('Error saving feedback:', error);
  }
};

// Helper function to handle conflict analysis and posting
const handleConflictAnalysis = async (
  octokit: any,
  owner: string,
  repo: string,
  prNumber: number,
  conflictAnalysis: string
) => {
  if (conflictAnalysis.includes("Conflicts Detected")) {
    await octokit.rest.issues.createComment({
      owner: owner,
      repo: repo,
      issue_number: prNumber,
      body: conflictAnalysis,
    });

    await postAIValidationForm(
      octokit,
      owner,
      repo,
      prNumber
    );
  } else {
    logger.info(`No semantic conflicts detected for PR #${prNumber}`);
    // Still track that we analyzed this PR, but no conflicts found
    await PrConflictAnalysisService.trackAnalysis(
      prNumber,
      owner,
      repo,
      false, // no conflicts detected
      false  // no validation form posted
    );
  }
};

app.webhooks.on('pull_request.opened', async ({ octokit, payload }) => {
  logger.info(
    `Received a pull request event for #${payload.pull_request.number}`
  );
  try {
    const files1 = await analyzePullRequest(
      octokit,
      payload.repository.owner.login,
      payload.repository.name,
      payload.pull_request.number,
      payload.pull_request.base.ref,
      payload.pull_request.head.ref
    );

    const files2 = await analyzePullRequest2(
      octokit,
      payload.repository.owner.login,
      payload.repository.name,
      payload.pull_request.number,
      payload.pull_request.base.ref,
      payload.pull_request.head.ref
    );

    const conflictAnalysis = await analyzeConflicts(files2);
    const reviewDifficulty = await calculateReviewDifficultyOfPR(files1);

    await handleConflictAnalysis(
      octokit,
      payload.repository.owner.login,
      payload.repository.name,
      payload.pull_request.number,
      conflictAnalysis
    );

    await PullRequestService.initiatePullRequestCreationFlow(
      payload,
      reviewDifficulty
    );
  } catch (error) {
    const customError = error as CustomError;
    if (customError.response) {
      logger.error(
        `Error! Status: ${customError.response.status}. Message: ${customError.response.data.message}`
      );
    } else {
      logger.error(customError.message || 'An unknown error occurred');
    }
  }
});

app.webhooks.on('issue_comment.created', async ({ octokit, payload }) => {
  if (payload.comment.user.login.includes('bot') || payload.comment.user.type === 'Bot') {
    return;
  }

  const commentBody = payload.comment.body.trim();

  if (
    commentBody.startsWith('#Confirm') ||
    commentBody.startsWith('#NotAConflict')
  ) {
    try {
      const { issue, comment } = payload;
      const prNumber = issue.number;
      const owner = payload.repository.owner.login;
      const repo = payload.repository.name;

      // Check if this PR was previously analyzed and had a validation form posted
      const wasAnalyzedWithValidationForm = await PrConflictAnalysisService.wasAnalyzedWithValidationForm(
        prNumber,
        owner,
        repo
      );

      if (!wasAnalyzedWithValidationForm) {
        logger.info(`Ignoring comment for PR #${prNumber} as it wasn't analyzed for conflicts or didn't have a validation form posted`);
        return;
      }

      let responseMessage = '';
      let conflictConfirmed = false;
      let explanation = null;

      if (commentBody.startsWith('#Confirm')) {
        responseMessage = `🚨 **AI Conflict Validation Feedback** 🚨\n\nThe reviewer has confirmed that **this is a conflict**. The \`semantic-conflict\` label has been applied.`;
        conflictConfirmed = true;
        logger.info(`Confirmed conflict for PR #${prNumber}`);

        await octokit.rest.issues.addLabels({
          owner: owner,
          repo: repo,
          issue_number: prNumber,
          labels: ['semantic-conflict'],
        });
      } else {
        explanation = commentBody.replace('#NotAConflict', '').trim();
        responseMessage = `📝 **AI Conflict Validation Feedback** 📝\n\nThe reviewer has determined that **this is not a conflict**.\n🛠 **Reason:** ${explanation ? explanation : '_No reason provided_'}`;
        logger.info(`Not a conflict for PR #${prNumber}: ${explanation || 'No reason provided'}`);
      }

      await octokit.rest.issues.createComment({
        owner: owner,
        repo: repo,
        issue_number: prNumber,
        body: responseMessage,
      });

      await logConflictFeedback(prNumber, conflictConfirmed, explanation);
    } catch (error) {
      const customError = error as CustomError;
      if (customError.response) {
        logger.error(
          `Error! Status: ${customError.response.status}. Message: ${customError.response.data.message}`
        );
      } else {
        logger.error(customError.message || 'An unknown error occurred');
      }
    }
  }
});

app.webhooks.on('pull_request.reopened', async ({ octokit, payload }) => {
  logger.info(
    `Received a pull request event for #${payload.pull_request.number}`
  );
  try {
    const files1 = await analyzePullRequest(
      octokit,
      payload.repository.owner.login,
      payload.repository.name,
      payload.pull_request.number,
      payload.pull_request.base.ref,
      payload.pull_request.head.ref
    );

    const files2 = await analyzePullRequest2(
      octokit,
      payload.repository.owner.login,
      payload.repository.name,
      payload.pull_request.number,
      payload.pull_request.base.ref,
      payload.pull_request.head.ref
    );

    const conflictAnalysis = await analyzeConflicts(files2);
    const reviewDifficulty = await calculateReviewDifficultyOfPR(files1);

    let pr = await PullRequestService.getPullRequestById(
      payload.pull_request.id.toString()
    );
    if (!pr) {
      pr = await PullRequestService.initiatePullRequestCreationFlow(
        payload,
        reviewDifficulty
      );
    } else {
      pr.reviewDifficulty = reviewDifficulty;
      await PullRequestService.updatePullRequest(pr);
    }

    await handleConflictAnalysis(
      octokit,
      payload.repository.owner.login,
      payload.repository.name,
      payload.pull_request.number,
      conflictAnalysis
    );
  } catch (error) {
    const customError = error as CustomError;
    if (customError.response) {
      logger.error(
        `Error! Status: ${customError.response.status}. Message: ${customError.response.data.message}`
      );
    } else {
      logger.error(customError.message || 'An unknown error occurred');
    }
  }
});

// Rest of your code remains the same
app.webhooks.on(
  ['pull_request.labeled', `pull_request.unlabeled`],
  async ({ octokit, payload }) => {
    try {
      if (!payload.sender.login.includes('bot')) {
        logger.info(`Received a label event for #${payload?.label?.name}`);

        let pr = await PullRequestService.getPullRequestById(
          payload?.pull_request?.id.toString()
        );
        if (!pr) {
          logger.info(`Pull request not found. Creating new pull request ...`);
          const files = await analyzePullRequest(
            octokit,
            payload.repository.owner.login,
            payload.repository.name,
            payload.pull_request.number,
            payload.pull_request.base.ref,
            payload.pull_request.head.ref
          );

          const reviewDifficulty = await calculateReviewDifficultyOfPR(files);
          pr = await PullRequestService.initiatePullRequestCreationFlow(
            payload,
            reviewDifficulty
          );
        }
        pr.labels = payload?.pull_request?.labels?.map((labels) => labels.name);
        await PullRequestService.updatePullRequest(pr);
        logger.info(`Pull request updated successfully`);
      }
    } catch (error) {
      const customError = error as CustomError;
      if (customError.response) {
        logger.error(
          `Error! Status: ${customError.response.status}. Message: ${customError.response.data.message}`
        );
      } else {
        logger.error(error);
      }
    }
  }
);

app.webhooks.on('pull_request.closed', async ({ octokit, payload }) => {
  try {
    const requests = await PRReviewRequestService.findByPRId(
      payload?.pull_request?.id?.toString()
    );
    if (requests) {
      await PRReviewRequestService.deleteRequest(requests);
    }
  } catch (error) {
    const customError = error as CustomError;
    if (customError.response) {
      logger.error(
        `Error! Status: ${customError.response.status}. Message: ${customError.response.data.message}`
      );
    } else {
      logger.error(error);
    }
  }
});

app.webhooks.on('pull_request', async ({ octokit, payload }) => {
  logger.info(
    `Received a pull request event for #${payload.pull_request.number}`
  );
  try {
    await prioritizePullRequest(
      octokit as any,
      payload.repository.owner.login,
      payload.repository.name,
      payload.pull_request.number
    );
  } catch (error) {
    const customError = error as CustomError;
    if (customError.response) {
      logger.error(
        `Error! Status: ${customError.response.status}. Message: ${customError.response.data.message}`
      );
    } else {
      logger.error(error);
    }
  }
});