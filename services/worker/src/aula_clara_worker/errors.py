class PipelineError(Exception):
    code = "pipeline_error"
    public_message = "O processamento encontrou um problema."
    transient = False


class TransientPipelineError(PipelineError):
    code = "temporary_failure"
    public_message = "O serviço está temporariamente indisponível. A etapa será repetida."
    transient = True


class InvalidMediaError(PipelineError):
    code = "invalid_media"
    public_message = "O arquivo não contém um áudio válido."


class InvalidPdfError(PipelineError):
    code = "invalid_pdf"
    public_message = "O PDF de slides está corrompido ou não pôde ser lido."


class FfmpegMissingError(PipelineError):
    code = "ffmpeg_missing"
    public_message = "O processador de áudio não está disponível. Contate o responsável pela instalação."


class ChunkTooLargeError(PipelineError):
    code = "chunk_too_large"
    public_message = "Um bloco de áudio permaneceu acima do limite permitido."


class NoSpeechError(PipelineError):
    code = "no_speech"
    public_message = "Não foi possível identificar fala no áudio."


class InvalidProviderResponse(TransientPipelineError):
    code = "invalid_provider_response"
    public_message = "O fornecedor retornou um formato inválido. A etapa será repetida de forma controlada."


class AuthenticationProviderError(PipelineError):
    code = "provider_authentication"
    public_message = "A credencial do serviço de IA precisa ser verificada."


class QuotaProviderError(PipelineError):
    code = "provider_quota"
    public_message = "A cota do serviço de IA está indisponível. Verifique a conta do fornecedor."


class ReviewRequiredError(PipelineError):
    code = "review_required"
    public_message = "Confirme as pendências da transcrição antes de gerar materiais."


class PdfGenerationError(PipelineError):
    code = "pdf_generation"
    public_message = "Não foi possível gerar o PDF da apostila."
