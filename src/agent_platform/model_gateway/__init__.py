"""应用内模型网关模块（T03，v0.2 §5.5 M1 形态）。

公开面：``ModelGateway``（chat/embed 统一出口）、``ModelGatewayError`` 族错误类型。
业务方不得直接 import openai/langfuse 发起模型调用。
"""
