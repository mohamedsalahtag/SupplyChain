-- Spec 12 revision: a container group has a name (e.g. "Mixed Gala"), set with its capacity and number of containers.
ALTER TABLE scm.ContainerGroup ADD Name nvarchar(60) NOT NULL CONSTRAINT DF_ContainerGroup_Name DEFAULT '';
