import { ProjectRegistry, CornerstoneProject } from "generated";
import { experimental_createEffect, S, type EffectContext } from "envio";
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";

// Setup RPC client with multicall enabled
const RPC_URL = process.env.RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const client = createPublicClient({
  chain: sepolia,
  batch: { multicall: true }, // Enable multicall batching
  transport: http(RPC_URL, { batch: true }),
});

// ABI for CornerstoneProject contract view functions
const projectContractAbi = [
  {
    inputs: [],
    name: "minRaise",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "maxRaise",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "withdrawableDevFunds",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// Helper to get contract instance
function getProjectContract(address: string) {
  return {
    address: address as `0x${string}`,
    abi: projectContractAbi,
  };
}

// Define the schema for the project metadata
const projectMetadataSchema = S.schema({
  name: S.string,
  description: S.string,
  image: S.string,
});

const projectStateSchema = S.schema({
  minRaise: S.bigint,
  maxRaise: S.bigint,
  withdrawableDevFunds: S.bigint,
});

type ProjectMetadata = S.Infer<typeof projectMetadataSchema>;
type ProjectStateData = S.Infer<typeof projectStateSchema>;

// Multiple IPFS gateway endpoints for redundancy
const ipfsEndpoints = [
  ...(process.env.IPFS_GATEWAY ? [process.env.IPFS_GATEWAY] : []),
  "https://w3s.link/ipfs",
  "https://cloudflare-ipfs.com/ipfs",
  "https://ipfs.io/ipfs",
  "https://gateway.pinata.cloud/ipfs",
];

// Helper function to normalize IPFS URIs
function normalizeMetadataURI(uri: string): string {
  // Remove ipfs:// prefix if present
  let normalized = uri.replace(/^ipfs:\/\//, "");
  
  // Add metadata.json if not present
  if (!normalized.endsWith("metadata.json") && !normalized.endsWith(".json")) {
    normalized = normalized.endsWith("/") 
      ? `${normalized}metadata.json` 
      : `${normalized}/metadata.json`;
  }
  
  return normalized;
}

// Fetch metadata from IPFS with fallback gateways (Original logic for image URI kept simple)
async function fetchMetadataFromEndpoint(
  context: EffectContext,
  endpoint: string,
  metadataPath: string
): Promise<ProjectMetadata | null> {
  try {
    const url = `${endpoint}/${metadataPath}`;
    context.log.info(`Attempting to fetch metadata from: ${url}`);
    
    const response = await fetch(url);
    
    if (response.ok) {
      const metadata: any = await response.json();
      
      // Store the image path/hash as provided, removing ipfs:// if present
      const imageURI = metadata.image 
        ? metadata.image.replace(/^ipfs:\/\//, "")
        : "";
      
      return {
        name: metadata.name || "",
        description: metadata.description || "",
        image: imageURI, // Storing the raw path/hash
      };
    } else {
      context.log.warn(`Metadata fetch returned non-200 status`, { 
        url, 
        status: response.status 
      });
      return null;
    }
  } catch (e) {
    context.log.warn(`Metadata fetch failed`, { 
      endpoint, 
      metadataPath, 
      error: e 
    });
    return null;
  }
}

// Create an effect for fetching project metadata
export const getProjectMetadata = experimental_createEffect(
  {
    name: "getProjectMetadata",
    input: S.string,
    output: projectMetadataSchema,
    cache: true, // Enable caching to avoid repeated fetches
  },
  async ({ input: metadataURI, context }) => {
    // Skip if no metadata URI provided
    if (!metadataURI || metadataURI === "") {
      context.log.info("No metadata URI provided");
      return { 
        name: "", 
        description: "", 
        image: "" 
      };
    }

    const normalizedPath = normalizeMetadataURI(metadataURI);
    context.log.info(`Fetching metadata from normalized path: ${normalizedPath}`);

    // Try each endpoint until one succeeds
    for (const endpoint of ipfsEndpoints) {
      const metadata = await fetchMetadataFromEndpoint(
        context, 
        endpoint, 
        normalizedPath
      );
      
      if (metadata) {
        context.log.info(`Successfully fetched metadata from ${endpoint}`);
        return metadata;
      }
    }

    // If all endpoints fail, log error and return empty values
    context.log.error(
      "Unable to fetch metadata from any IPFS gateway",
      { metadataURI, normalizedPath }
    );
    
    return { 
      name: "", 
      description: "", 
      image: "" 
    };
  }
);

export const getProjectContractState = experimental_createEffect(
  {
    name: "getProjectContractState",
    input: S.string, // Input is the project address
    output: projectStateSchema,
    cache: true,
  },
  async ({ input: projectAddress, context }) => {
    context.log.info(`Fetching contract state for: ${projectAddress}`);
    
    const projectContract = getProjectContract(projectAddress);
    
    try {
      // Use multicall to batch all three contract calls efficiently
      const results = await client.multicall({
        allowFailure: false,
        contracts: [
          {
            ...projectContract,
            functionName: "minRaise",
          },
          {
            ...projectContract,
            functionName: "maxRaise",
          },
          {
            ...projectContract,
            functionName: "withdrawableDevFunds",
          },
        ],
      });

      const [minRaise, maxRaise, withdrawableDevFunds] = results;

      return {
        minRaise: minRaise as bigint,
        maxRaise: maxRaise as bigint,
        withdrawableDevFunds: withdrawableDevFunds as bigint,
      };
    } catch (error) {
      context.log.error(`Failed to fetch contract state for ${projectAddress}`, {
        error: error,
      });
      // Return default values on error
      return {
        minRaise: 0n,
        maxRaise: 0n,
        withdrawableDevFunds: 0n,
      };
    }
  }
);

export const getWithdrawableDevFunds = experimental_createEffect(
  {
    name: "getWithdrawableDevFunds",
    input: S.string, 
    output: S.bigint,
    cache: false, // Don't cache this as it changes frequently
  },
  async ({ input: projectAddress, context }) => {
    const projectContract = getProjectContract(projectAddress);
    
    try {
      const result = await client.readContract({
        ...projectContract,
        functionName: "withdrawableDevFunds",
      });
      
      return result as bigint;
    } catch (error) {
      context.log.error(`Failed to fetch withdrawableDevFunds for ${projectAddress}`, {
        error: error,
      });
      return 0n;
    }
  }
);

// Register new CornerstoneProject contracts dynamically
ProjectRegistry.ProjectCreated.contractRegister(({ event, context }) => {
  context.addCornerstoneProject(event.params.project);
});

export const handleProjectCreated = ProjectRegistry.ProjectCreated.handler(
  async ({ event, context }) => {
    const projectAddress = event.params.project.toLowerCase();
    const txHash = event.block.hash;

    // Get metadataURI from event params
    const metadataURI = event.params.metadataURI || "";

    // Fetch metadata from IPFS if metadataURI is provided
    let metadata: ProjectMetadata | undefined;
    let metadataFetchError: string | undefined;
    
    if (metadataURI && metadataURI !== "") {
      try {
        metadata = await context.effect(getProjectMetadata, metadataURI);
      } catch (error) {
        context.log.error("Error fetching project metadata", error as Error);
        metadataFetchError = (error as Error).message;
      }
    }

    let contractState: ProjectStateData | undefined;
    try {
      // This call now uses the robust getProjectContractState effect
      contractState = await context.effect(
        getProjectContractState, 
        event.params.project // Pass the contract address
      );
    } catch (error) {
      // This catch block should rarely be hit if the effect is robust, 
      // but it remains as a final safeguard.
      context.log.error(
        "Fatal error fetching project contract state with effect", 
        error as Error
      );
    }

    // Default to 0n if contractState is undefined or properties are missing (due to effect failing gracefully)
    const minRaise = contractState?.minRaise ?? 0n;
    const maxRaise = contractState?.maxRaise ?? 0n;
    const withdrawableDevFunds = contractState?.withdrawableDevFunds ?? 0n;

    context.Project.set({
      id: projectAddress,
      address: event.params.project,
      tokenAddress: event.params.token,
      creator: event.params.creator,
      createdAtBlock: BigInt(event.block.number),
      createdAtTimestamp: BigInt(event.block.timestamp),
      metadataURI: metadataURI,
      projectState_id: projectAddress,
      description: metadata?.description,
      imageURI: metadata?.image,
      metadataFetchError: metadataFetchError,
      metadataFetched: metadata !== undefined,
      name: metadata?.name,
      minRaise: minRaise,              
      maxRaise: maxRaise,              
      withdrawableDevFunds: withdrawableDevFunds,
    });

    context.ProjectCreatedEvent.set({
      id: `${txHash}-${event.logIndex}`,
      project_id: projectAddress,
      token: event.params.token,
      creator: event.params.creator,
      blockNumber: BigInt(event.block.number),
      blockTimestamp: BigInt(event.block.timestamp),
      transactionHash: txHash,
    });

    context.ProjectState.set({
      id: projectAddress,
      project_id: projectAddress,
      currentPhase: 0,
      lastClosedPhase: 0,
      fundraiseClosed: false,
      fundraiseSuccessful: false,
      totalRaised: 0n,
      totalDevWithdrawn: 0n,
      reserveBalance: 0n,
      poolBalance: 0n,
      principalBuffer: 0n,
      principalRedeemed: 0n,
      accrualBase: 0n,
      phase5PercentComplete: 0n,
      lastAppraisalHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      interestPerShareX18: 0n,
      revenuePerShareX18: 0n,
      lastUpdatedBlock: BigInt(event.block.number),
      lastUpdatedTimestamp: BigInt(event.block.timestamp),
    });

    // Get phase caps from contract storage
    // We need to calculate the phase caps from the contract's phaseCapsBps and maxRaise
    // For now, we'll set them to 0 and they can be updated later when we have a way to call contract functions
    for (let i = 0; i <= 5; i++) {
      const phaseMetricsId = `${projectAddress}-phase-${i}`;
      context.PhaseMetrics.set({
        id: phaseMetricsId,
        project_id: projectAddress,
        projectState_id: projectAddress,
        phaseId: i,
        phaseCap: 0n, // TODO: Calculate from contract storage
        phaseWithdrawn: 0n,
        aprBps: 0n, // TODO: Get from contract storage
        duration: 0n, // TODO: Get from contract storage
        capBps: 0n, // TODO: Get from contract storage
        isClosed: false,
        closedAtBlock: undefined,
        closedAtTimestamp: undefined,
      });
    }

    let registry = await context.ProjectRegistry.get("registry");
    if (!registry) {
      context.ProjectRegistry.set({
        id: "registry",
        address: event.srcAddress,
        totalProjectsCreated: 1,
        lastUpdatedBlock: BigInt(event.block.number),
        lastUpdatedTimestamp: BigInt(event.block.timestamp),
      });
    } else {
      context.ProjectRegistry.set({
        ...registry,
        totalProjectsCreated: registry.totalProjectsCreated + 1,
        lastUpdatedBlock: BigInt(event.block.number),
        lastUpdatedTimestamp: BigInt(event.block.timestamp),
      });
    }
  }
);

export const handleDeposit = CornerstoneProject.Deposit.handler(
  async ({ event, context }) => {
    const depositorId = event.params.user.toLowerCase();
    const projectAddress = event.srcAddress.toLowerCase();

    let project = await context.Project.get(projectAddress);
    if (project) {
      try {
        const withdrawableDevFunds = await context.effect(
          getWithdrawableDevFunds,
          event.srcAddress
        );
        
        context.Project.set({
          ...project,
          withdrawableDevFunds: withdrawableDevFunds,
        });
      } catch (error) {
        context.log.error("Error updating withdrawableDevFunds", error as Error);
      }
    }

    let depositor = await context.Depositor.get(depositorId);

    if (!depositor) {
      context.Depositor.set({
        id: depositorId,
        totalDeposited: event.params.amount,
        sharesHeld: event.params.sharesMinted,
        interestClaimed: 0n,
        revenueClaimed: 0n,
        principalRedeemed: 0n,
        lastDepositBlock: BigInt(event.block.number),
        lastDepositTimestamp: BigInt(event.block.timestamp),
      });
    } else {
      context.Depositor.set({
        ...depositor,
        sharesHeld: depositor.sharesHeld + event.params.sharesMinted,
        totalDeposited: depositor.totalDeposited + event.params.amount,
        lastDepositBlock: BigInt(event.block.number),
        lastDepositTimestamp: BigInt(event.block.timestamp),
      });
    }

    const txHash = event.block.hash;

    context.DepositEvent.set({
      id: `${txHash}-${event.logIndex}`,
      depositor_id: depositorId,
      project_id: projectAddress,
      projectAddress: event.srcAddress,
      amountPYUSD: event.params.amount,
      sharesMinted: event.params.sharesMinted,
      blockNumber: BigInt(event.block.number),
      blockTimestamp: BigInt(event.block.timestamp),
      transactionHash: txHash,
    });

    let projectState = await context.ProjectState.get(projectAddress);
    if (projectState) {
      context.ProjectState.set({
        ...projectState,
        totalRaised: projectState.totalRaised + event.params.amount,
        poolBalance: projectState.poolBalance + event.params.amount,
        accrualBase: projectState.accrualBase + event.params.amount,
        lastUpdatedBlock: BigInt(event.block.number),
        lastUpdatedTimestamp: BigInt(event.block.timestamp),
      });
    }

    await updateDepositorMetrics(depositorId, projectAddress, event, context);
  }
);

export const handleInterestClaimed = CornerstoneProject.InterestClaimed.handler(
  async ({ event, context }) => {
    const claimerId = event.params.user.toLowerCase();
    const projectAddress = event.srcAddress.toLowerCase();

    let depositor = await context.Depositor.get(claimerId);
    if (depositor) {
      context.Depositor.set({
        ...depositor,
        interestClaimed: depositor.interestClaimed + event.params.amount,
      });
    }

    const txHash = event.block.hash;

    context.InterestClaimedEvent.set({
      id: `${txHash}-${event.logIndex}`,
      claimer_id: claimerId,
      project_id: projectAddress,
      projectAddress: event.srcAddress,
      amount: event.params.amount,
      blockNumber: BigInt(event.block.number),
      blockTimestamp: BigInt(event.block.timestamp),
      transactionHash: txHash,
    });

    let projectState = await context.ProjectState.get(projectAddress);
    if (projectState) {
      context.ProjectState.set({
        ...projectState,
        poolBalance: projectState.poolBalance >= event.params.amount 
          ? projectState.poolBalance - event.params.amount 
          : 0n,
        accrualBase: projectState.accrualBase >= event.params.amount
          ? projectState.accrualBase - event.params.amount
          : 0n,
        lastUpdatedBlock: BigInt(event.block.number),
        lastUpdatedTimestamp: BigInt(event.block.timestamp),
      });
    }

    await updateDepositorMetrics(claimerId, projectAddress, event, context);
  }
);

export const handleReserveFunded = CornerstoneProject.ReserveFunded.handler(
  async ({ event, context }) => {
    const projectAddress = event.srcAddress.toLowerCase();
    const txHash = event.block.hash;

    context.ReserveFundedEvent.set({
      id: `${txHash}-${event.logIndex}`,
      project_id: projectAddress,
      projectAddress: event.srcAddress,
      amount: event.params.amount,
      fundedBy: event.params.by,
      blockNumber: BigInt(event.block.number),
      blockTimestamp: BigInt(event.block.timestamp),
      transactionHash: txHash,
    });

    let projectState = await context.ProjectState.get(projectAddress);
    if (projectState) {
      context.ProjectState.set({
        ...projectState,
        reserveBalance: projectState.reserveBalance + event.params.amount,
        lastUpdatedBlock: BigInt(event.block.number),
        lastUpdatedTimestamp: BigInt(event.block.timestamp),
      });
    }
  }
);

export const handleFundraiseClosed = CornerstoneProject.FundraiseClosed.handler(
  async ({ event, context }) => {
    const projectAddress = event.srcAddress.toLowerCase();
    const txHash = event.block.hash;

    context.FundraiseClosedEvent.set({
      id: `${txHash}-${event.logIndex}`,
      project_id: projectAddress,
      projectAddress: event.srcAddress,
      successful: event.params.successful,
      blockNumber: BigInt(event.block.number),
      blockTimestamp: BigInt(event.block.timestamp),
      transactionHash: txHash,
    });

    let projectState = await context.ProjectState.get(projectAddress);
    if (projectState) {
      context.ProjectState.set({
        ...projectState,
        fundraiseClosed: true,
        fundraiseSuccessful: event.params.successful,
        lastUpdatedBlock: BigInt(event.block.number),
        lastUpdatedTimestamp: BigInt(event.block.timestamp),
      });
    }
  }
);

export const handlePhaseClosed = CornerstoneProject.PhaseClosed.handler(
  async ({ event, context }) => {
    const projectAddress = event.srcAddress.toLowerCase();
    const txHash = event.block.hash;
    const phaseId = Number(event.params.phaseId);

    context.PhaseClosedEvent.set({
      id: `${txHash}-${event.logIndex}`,
      project_id: projectAddress,
      phaseId: phaseId,
      docTypes: event.params.docTypes,
      docHashes: event.params.docHashes,
      metadataURIs: event.params.metadataURIs,
      blockNumber: BigInt(event.block.number),
      blockTimestamp: BigInt(event.block.timestamp),
      transactionHash: txHash,
    });

    const phaseMetricsId = `${projectAddress}-phase-${phaseId}`;
    let phaseMetrics = await context.PhaseMetrics.get(phaseMetricsId);

    if (phaseMetrics) {
      context.PhaseMetrics.set({
        ...phaseMetrics,
        isClosed: true,
        closedAtBlock: BigInt(event.block.number),
        closedAtTimestamp: BigInt(event.block.timestamp),
      });
    }

    let projectState = await context.ProjectState.get(projectAddress);
    if (projectState) {
      const newCurrentPhase = phaseId === 5 ? 5 : phaseId + 1;
      
      context.ProjectState.set({
        ...projectState,
        currentPhase: newCurrentPhase,
        lastClosedPhase: phaseId,
        lastUpdatedBlock: BigInt(event.block.number),
        lastUpdatedTimestamp: BigInt(event.block.timestamp),
      });
    }
  }
);

export const handlePhaseFundsWithdrawn = CornerstoneProject.PhaseFundsWithdrawn.handler(
  async ({ event, context }) => {
    const projectAddress = event.srcAddress.toLowerCase();
    const txHash = event.block.hash;
    const phaseId = Number(event.params.phaseId);

    let project = await context.Project.get(projectAddress);
    if (project) {
      try {
        const withdrawableDevFunds = await context.effect(
          getWithdrawableDevFunds,
          event.srcAddress
        );
        
        context.Project.set({
          ...project,
          withdrawableDevFunds: withdrawableDevFunds,
        });
      } catch (error) {
        context.log.error("Error updating withdrawableDevFunds", error as Error);
      }
    }

    context.PhaseFundsWithdrawnEvent.set({
      id: `${txHash}-${event.logIndex}`,
      project_id: projectAddress,
      projectAddress: event.srcAddress,
      phaseId: phaseId,
      amount: event.params.amount,
      blockNumber: BigInt(event.block.number),
      blockTimestamp: BigInt(event.block.timestamp),
      transactionHash: txHash,
    });

    const phaseMetricsId = `${projectAddress}-phase-${phaseId}`;
    let phaseMetrics = await context.PhaseMetrics.get(phaseMetricsId);

    if (phaseMetrics) {
      context.PhaseMetrics.set({
        ...phaseMetrics,
        phaseWithdrawn: phaseMetrics.phaseWithdrawn + event.params.amount,
      });
    }

    let projectState = await context.ProjectState.get(projectAddress);
    if (projectState) {
      context.ProjectState.set({
        ...projectState,
        totalDevWithdrawn: projectState.totalDevWithdrawn + event.params.amount,
        poolBalance: projectState.poolBalance >= event.params.amount
          ? projectState.poolBalance - event.params.amount
          : 0n,
        lastUpdatedBlock: BigInt(event.block.number),
        lastUpdatedTimestamp: BigInt(event.block.timestamp),
      });
    }
  }
);

export const handleAppraisalSubmitted = CornerstoneProject.AppraisalSubmitted.handler(
  async ({ event, context }) => {
    const projectAddress = event.srcAddress.toLowerCase();
    const txHash = event.block.hash;

    context.AppraisalSubmittedEvent.set({
      id: `${txHash}-${event.logIndex}`,
      project_id: projectAddress,
      projectAddress: event.srcAddress,
      percentComplete: event.params.percentComplete,
      appraisalHash: event.params.appraisalHash,
      blockNumber: BigInt(event.block.number),
      blockTimestamp: BigInt(event.block.timestamp),
      transactionHash: txHash,
    });

    let projectState = await context.ProjectState.get(projectAddress);
    if (projectState) {
      context.ProjectState.set({
        ...projectState,
        phase5PercentComplete: event.params.percentComplete,
        lastAppraisalHash: event.params.appraisalHash,
        lastUpdatedBlock: BigInt(event.block.number),
        lastUpdatedTimestamp: BigInt(event.block.timestamp),
      });
    }
  }
);

export const handleSalesProceedsSubmitted = CornerstoneProject.SalesProceedsSubmitted.handler(
  async ({ event, context }) => {
    const projectAddress = event.srcAddress.toLowerCase();
    const txHash = event.block.hash;

    context.SalesProceedsSubmittedEvent.set({
      id: `${txHash}-${event.logIndex}`,
      project_id: projectAddress,
      projectAddress: event.srcAddress,
      amount: event.params.amount,
      blockNumber: BigInt(event.block.number),
      blockTimestamp: BigInt(event.block.timestamp),
      transactionHash: txHash,
    });

    let projectState = await context.ProjectState.get(projectAddress);
    if (projectState) {
      context.ProjectState.set({
        ...projectState,
        poolBalance: projectState.poolBalance + event.params.amount,
        accrualBase: projectState.accrualBase + event.params.amount,
        principalBuffer: projectState.principalBuffer + event.params.amount,
        lastUpdatedBlock: BigInt(event.block.number),
        lastUpdatedTimestamp: BigInt(event.block.timestamp),
      });
    }
  }
);

export const handlePrincipalClaimed = CornerstoneProject.PrincipalClaimed.handler(
  async ({ event, context }) => {
    const claimerId = event.params.user.toLowerCase();
    const projectAddress = event.srcAddress.toLowerCase();

    let depositor = await context.Depositor.get(claimerId);
    if (depositor) {
      const newSharesHeld = depositor.sharesHeld >= event.params.amount
        ? depositor.sharesHeld - event.params.amount
        : 0n;

      context.Depositor.set({
        ...depositor,
        principalRedeemed: depositor.principalRedeemed + event.params.amount,
        sharesHeld: newSharesHeld,
      });
    }

    const txHash = event.block.hash;

    context.PrincipalClaimedEvent.set({
      id: `${txHash}-${event.logIndex}`,
      claimer_id: claimerId,
      project_id: projectAddress,
      projectAddress: event.srcAddress,
      amount: event.params.amount,
      blockNumber: BigInt(event.block.number),
      blockTimestamp: BigInt(event.block.timestamp),
      transactionHash: txHash,
    });

    let projectState = await context.ProjectState.get(projectAddress);
    if (projectState) {
      context.ProjectState.set({
        ...projectState,
        principalBuffer: projectState.principalBuffer >= event.params.amount
          ? projectState.principalBuffer - event.params.amount
          : 0n,
        principalRedeemed: projectState.principalRedeemed + event.params.amount,
        poolBalance: projectState.poolBalance >= event.params.amount
          ? projectState.poolBalance - event.params.amount
          : 0n,
        accrualBase: projectState.accrualBase >= event.params.amount
          ? projectState.accrualBase - event.params.amount
          : 0n,
        lastUpdatedBlock: BigInt(event.block.number),
        lastUpdatedTimestamp: BigInt(event.block.timestamp),
      });
    }

    await updateDepositorMetrics(claimerId, projectAddress, event, context);
  }
);

export const handleRevenueClaimed = CornerstoneProject.RevenueClaimed.handler(
  async ({ event, context }) => {
    const claimerId = event.params.user.toLowerCase();
    const projectAddress = event.srcAddress.toLowerCase();

    let depositor = await context.Depositor.get(claimerId);
    if (depositor) {
      context.Depositor.set({
        ...depositor,
        revenueClaimed: depositor.revenueClaimed + event.params.amount,
      });
    }

    const txHash = event.block.hash;

    context.RevenueClaimedEvent.set({
      id: `${txHash}-${event.logIndex}`,
      claimer_id: claimerId,
      project_id: projectAddress,
      projectAddress: event.srcAddress,
      amount: event.params.amount,
      blockNumber: BigInt(event.block.number),
      blockTimestamp: BigInt(event.block.timestamp),
      transactionHash: txHash,
    });

    let projectState = await context.ProjectState.get(projectAddress);
    if (projectState) {
      context.ProjectState.set({
        ...projectState,
        poolBalance: projectState.poolBalance >= event.params.amount
          ? projectState.poolBalance - event.params.amount
          : 0n,
        lastUpdatedBlock: BigInt(event.block.number),
        lastUpdatedTimestamp: BigInt(event.block.timestamp),
      });
    }

    await updateDepositorMetrics(claimerId, projectAddress, event, context);
  }
);

export const handlePhaseConfiguration = CornerstoneProject.PhaseConfiguration.handler(
  async ({ event, context }) => {
    const projectAddress = event.srcAddress.toLowerCase();
    const txHash = event.block.hash;
    const aprBps = Array.from(event.params.aprBps);
    const durations = Array.from(event.params.durations);
    const capBps = Array.from(event.params.capBps);
    const phaseCaps = Array.from(event.params.phaseCaps);

    // Store the phase configuration event
    context.PhaseConfigurationEvent.set({
      id: `${txHash}-${event.logIndex}`,
      project_id: projectAddress,
      aprBps,
      durations,
      capBps,
      phaseCaps,
      blockNumber: BigInt(event.block.number),
      blockTimestamp: BigInt(event.block.timestamp),
      transactionHash: txHash,
    });

    const maxPhases = Math.min(aprBps.length, 6);
    for (let i = 0; i < maxPhases; i++) {
      const phaseMetricsId = `${projectAddress}-phase-${i}`;
      const phaseMetrics = await context.PhaseMetrics.get(phaseMetricsId);

      context.PhaseMetrics.set({
        id: phaseMetricsId,
        project_id: projectAddress,
        projectState_id: projectAddress,
        phaseId: i,
        phaseCap: phaseCaps[i] ?? 0n,
        phaseWithdrawn: phaseMetrics?.phaseWithdrawn ?? 0n,
        aprBps: aprBps[i] ?? 0n,
        duration: durations[i] ?? 0n,
        capBps: capBps[i] ?? 0n,
        isClosed: phaseMetrics?.isClosed ?? false,
        closedAtBlock: phaseMetrics?.closedAtBlock,
        closedAtTimestamp: phaseMetrics?.closedAtTimestamp,
      });
    }
  }
);

async function updateDepositorMetrics(
  userId: string,
  projectAddress: string,
  event: any,
  context: any
): Promise<void> {
  const metricsId = `${projectAddress}-${userId}`.toLowerCase();

  let metrics = await context.DepositorMetrics.get(metricsId);
  const depositor = await context.Depositor.get(userId);

  if (!depositor) return;

  if (!metrics) {
    // Creating new metrics - this is the first activity for this user on this project
    const isFirstDeposit = event.name === "Deposit";

    context.DepositorMetrics.set({
      id: metricsId,
      user: userId,
      project_id: projectAddress,
      projectAddress: projectAddress,
      depositCount: isFirstDeposit ? 1n : 0n,
      totalDeposited: depositor.totalDeposited,
      currentShares: depositor.sharesHeld,
      claimableInterest: 0n,
      claimableRevenue: 0n,
      totalInterestClaimed: depositor.interestClaimed,
      totalRevenueClaimed: depositor.revenueClaimed,
      totalPrincipalRedeemed: depositor.principalRedeemed,
      firstDepositBlock: depositor.lastDepositBlock,
      firstDepositTimestamp: depositor.lastDepositTimestamp,
      lastActivityBlock: BigInt(event.block.number),
      lastActivityTimestamp: BigInt(event.block.timestamp),
    });
  } else {
    const isNewDeposit = event.name === "Deposit";
    
    context.DepositorMetrics.set({
      ...metrics,
      depositCount: isNewDeposit ? metrics.depositCount + 1n : metrics.depositCount,
      totalDeposited: depositor.totalDeposited,
      currentShares: depositor.sharesHeld,
      totalInterestClaimed: depositor.interestClaimed,
      totalRevenueClaimed: depositor.revenueClaimed,
      totalPrincipalRedeemed: depositor.principalRedeemed,
      lastActivityBlock: BigInt(event.block.number),
      lastActivityTimestamp: BigInt(event.block.timestamp),
    });
  }
}