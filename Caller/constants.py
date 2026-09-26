"""Shared constants for the intake and delivery agents."""

import os

# Guava number that receives the intake calls and places the delivery calls.
# GUAVA_AGENT_NUMBER overrides it when set.
AGENT_PHONE_NUMBER = os.environ.get("GUAVA_AGENT_NUMBER", "+14849622356")

SENDER_NAME = "Andres Felipe"
ORGANIZATION = "Mango Ai"

#7818357945
#9792241010