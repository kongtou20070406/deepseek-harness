import type {
  ResearchEvidenceRequirementAssessment,
  ResearchEvidenceSupportProjection,
  ResearchInquiryNode,
  ResearchInquiryState,
} from './types.ts'

function usableEvidence(node: ResearchInquiryNode | undefined): node is ResearchInquiryNode {
  return node !== undefined
    && (node.kind === 'evidence' || node.kind === 'counterevidence')
    && node.sourceSeqs.length > 0
    && node.status !== 'retired'
    && node.status !== 'rejected'
}

/**
 * Compute structural Idea support without trusting a model-authored status label.
 *
 * A linked, source-addressed observation is a support lead, not a closure
 * verdict. Any active source-backed challenge keeps the requirement
 * challenged. This function never reads bulk data and stays cheap enough for
 * the request hot path.
 */
export function evaluateResearchEvidenceSupport(
  inquiry: ResearchInquiryState | undefined,
): ResearchEvidenceSupportProjection {
  const requirements = inquiry?.nodes.filter(node => node.kind === 'evidence-requirement') ?? []
  if (requirements.length === 0) {
    return Object.freeze({
      status: 'untracked', requirements: [], candidateCount: 0, challengedCount: 0,
    })
  }

  const nodes = new Map((inquiry?.nodes ?? []).map(node => [node.id, node] as const))
  const assessments: ResearchEvidenceRequirementAssessment[] = requirements.map((requirement) => {
    const direct = (inquiry?.edges ?? []).filter(edge => edge.toId === requirement.id)
    const supporting = direct
      .filter(edge => edge.relation === 'supports')
      .map(edge => nodes.get(edge.fromId))
      .filter(usableEvidence)
      .filter(node => node.kind === 'evidence')
    const supportIds = new Set(supporting.map(node => node.id))
    const challenging = (inquiry?.edges ?? [])
      .filter(edge => edge.relation === 'challenges'
        && (edge.toId === requirement.id || supportIds.has(edge.toId)))
      .map(edge => nodes.get(edge.fromId))
      .filter(usableEvidence)
    const status = challenging.length > 0
      ? 'challenged'
      : supporting.length > 0
        ? 'candidate'
        : 'open'
    return Object.freeze({
      requirementId: requirement.id,
      evidenceClass: requirement.evidenceClass ?? 'task-effect',
      status,
      supportingNodeIds: supporting.map(node => node.id),
      challengingNodeIds: challenging.map(node => node.id),
    })
  })

  const candidateCount = assessments.filter(item => item.status === 'candidate').length
  const challengedCount = assessments.filter(item => item.status === 'challenged').length
  const status = challengedCount > 0
    ? 'challenged'
    : candidateCount > 0
      ? 'candidate'
      : 'open'
  return Object.freeze({ status, requirements: assessments, candidateCount, challengedCount })
}
