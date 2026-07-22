"""Capa de servicios de dominio.

Lógica de negocio que NO depende de FastAPI ni del request HTTP: se le inyecta
`db` como parámetro para que sea testeable sin servidor ni base de datos real.
"""
