package com.ailifetime.sdk;

import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.regex.Pattern;

public record ConsentScope(String resource, List<String> actions) {
    private static final Pattern RESOURCE = Pattern.compile("[a-z][a-z0-9_.-]{0,63}:[A-Za-z0-9][A-Za-z0-9._:-]{0,191}");
    private static final Pattern ACTION = Pattern.compile("[a-z][a-z0-9_.:-]{0,79}");

    public ConsentScope {
        Objects.requireNonNull(resource, "resource");
        Objects.requireNonNull(actions, "actions");
        if (!RESOURCE.matcher(resource).matches()) {
            throw new IllegalArgumentException("consent scope resource is invalid");
        }
        actions = List.copyOf(actions);
        if (actions.isEmpty()
            || actions.size() > 32
            || new HashSet<>(actions).size() != actions.size()
            || actions.stream().anyMatch(action -> action == null || !ACTION.matcher(action).matches())) {
            throw new IllegalArgumentException("consent scope actions are invalid");
        }
    }
}
