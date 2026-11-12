"""模型网关错误类型（T03 验收：调用失败有明确错误类型，不裸抛供应商异常）。

调用方（入库向量化、Chat Run）只捕获 ModelGatewayError 族，
供应商 SDK 的具体异常在网关内完成翻译。
"""


class ModelGatewayError(Exception):
    """模型网关错误基类。attributes: capability/model/cause 便于审计与重试决策。"""

    def __init__(self, message: str, *, capability: str, model: str, cause: Exception | None = None):
        super().__init__(message)
        self.capability = capability
        self.model = model
        self.cause = cause


class ModelConfigError(ModelGatewayError):
    """网关配置缺失或非法（如映射表指向不存在的供应商端点）。"""


class ModelAuthError(ModelGatewayError):
    """供应商认证失败（401/403）：凭证错误或过期。"""


class ModelRateLimitError(ModelGatewayError):
    """供应商限流（429）：调用方可据此退避重试。"""


class ModelUnavailableError(ModelGatewayError):
    """供应商不可达/超时/5xx：调用方可换模型或稍后重试。"""


class ModelBadRequestError(ModelGatewayError):
    """请求被供应商拒绝（400 类）：参数非法、模型不存在等。"""
