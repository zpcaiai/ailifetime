"""TimeCapsule ('一生拾忆时光机') Independent Business Domain Package (P00-P14)."""

from .ai_orchestrator import AIProviderRouter, GenerationJobService
from .catalog_service import CatalogService
from .db_and_identity import (
    SPEC_ROOT,
    AuthenticatedSession,
    IdentityConsentService,
    SpecContractValidator,
    TimeCapsuleDatabase,
    TimeCapsuleError,
    sha256_hex,
    utc_now_iso,
)
from .deterministic_renderer import DeterministicRenderer
from .export_labeling import ExportLabelingService
from .http_server import TimeCapsuleApplication, create_http_server
from .media_vault import MediaVaultService
from .multiplatform_and_album import (
    MemorialAlbumVideoService,
    ObservabilitySLOService,
    PlatformSurfaceAdapter,
)
from .payments_entitlement import PaymentEntitlementService
from .timeline_moderation import ContentModerationService, TimelineArchiveService

__all__ = [
    "AIProviderRouter",
    "AuthenticatedSession",
    "CatalogService",
    "ContentModerationService",
    "DeterministicRenderer",
    "ExportLabelingService",
    "GenerationJobService",
    "IdentityConsentService",
    "IndependentEvidenceRunner",
    "MediaVaultService",
    "MemorialAlbumVideoService",
    "ObservabilitySLOService",
    "PaymentEntitlementService",
    "PlatformSurfaceAdapter",
    "SPEC_ROOT",
    "SpecContractValidator",
    "TimeCapsuleApplication",
    "TimeCapsuleDatabase",
    "TimeCapsuleError",
    "TimelineArchiveService",
    "create_http_server",
    "sha256_hex",
    "utc_now_iso",
]


def __getattr__(name: str):
    if name == "IndependentEvidenceRunner":
        from .evidence_runner import IndependentEvidenceRunner

        return IndependentEvidenceRunner
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
